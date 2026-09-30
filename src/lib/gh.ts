import { Command } from '@tauri-apps/plugin-shell'
import type { CiChecks, CiState, MergeMethod } from '../types'
import { errText, logError } from './log'
import { type GhMergeSettings, type MergeOptions, mergeArgs, parseMergeOptions } from './merge'
import { ciChecks, hasApproval, hasConflicts, rollupToCiState } from './prboard'

// Every gh failure is logged here rather than at the call sites: most of them swallow the rejection
// to keep one bad repo (or one unreachable PR) from emptying a board, which used to mean a broken
// `gh` looked exactly like a PR with no activity.
const fail = (message: string): never => {
  logError('gh', message)
  throw new Error(message)
}

const gh = async (args: string[], cwd?: string): Promise<string> => {
  const label = `gh ${args.join(' ')}`
  const out = await Command.create('gh', args, cwd ? { cwd } : undefined)
    .execute()
    // gh missing from PATH (a packaged build starts from launchd's bare PATH) or denied by the shell scope
    .catch((e) => fail(`${label} could not start: ${errText(e)}`))
  if (out.code !== 0) fail(`${label} failed: ${out.stderr.trim()}`)
  return out.stdout
}

// owner/repo derived from the clone's git origin remote
export const repoFromPath = async (path: string): Promise<string> =>
  (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], path)).trim()

export const fetchLogin = async (): Promise<string> => (await gh(['api', 'user', '--jq', '.login'])).trim()

// GitHub profile name (e.g. "Francis Chartrand") — matches git commit author names, which carry no login
export const fetchName = async (): Promise<string> => (await gh(['api', 'user', '--jq', '.name // ""'])).trim()

export type GhPr = {
  number: number
  title: string
  url: string
  headRefName: string
  author: { login: string }
  createdAt: string
  isDraft: boolean
  reviewRequests: { login?: string }[]
  latestReviews: { author: { login: string }; state: string }[]
}

export const listOpenPrs = async (repo: string): Promise<GhPr[]> =>
  JSON.parse(
    await gh([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,url,headRefName,author,createdAt,isDraft,reviewRequests,latestReviews',
    ]),
  )

// the approval rides along: a PR approved and merged between two syncs was never seen approved by
// the open-PR listing
export const fetchPrState = async (
  repo: string,
  prNumber: number,
): Promise<{ state: 'open' | 'merged' | 'closed'; approved: boolean }> => {
  const out = JSON.parse(await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,latestReviews']))
  return {
    state: out.state.toLowerCase() as 'open' | 'merged' | 'closed',
    approved: hasApproval(out.latestReviews ?? []),
  }
}

// PR numbers with a conversation comment from me (comments are not "reviews" in GitHub's model)
export const listCommentedByMe = async (repo: string, me: string): Promise<Set<number>> => {
  const out = JSON.parse(
    await gh(['search', 'prs', '--repo', repo, '--commenter', me, '--state', 'open', '--json', 'number']),
  ) as { number: number }[]
  return new Set(out.map((pr) => pr.number))
}

export type GhTimelineEvent = {
  ts: string
  kind: 'commit' | 'comment' | 'review' | 'review_requested' | 'merged' | 'closed' | 'reopened' | 'force_pushed'
  actor: string
  text: string
  url?: string
  // the picture GitHub sent: github.com/<login>.png has none for a bot (`some-app[bot]`) or a git name
  avatar?: string
}

// biome-ignore lint/suspicious/noExplicitAny: untyped REST payload
const eventAvatar = (e: any): string | undefined => e.user?.avatar_url ?? e.actor?.avatar_url ?? undefined

// biome-ignore lint/suspicious/noExplicitAny: untyped REST payload
const toEvent = (e: any): GhTimelineEvent | null => {
  switch (e.event) {
    case 'commented':
      return { ts: e.created_at, kind: 'comment', actor: e.user?.login ?? '', text: 'commented', url: e.html_url }
    case 'reviewed': {
      const state = (e.state ?? '').toLowerCase().replace('_', ' ')
      return { ts: e.submitted_at, kind: 'review', actor: e.user?.login ?? '', text: state, url: e.html_url }
    }
    case 'review_requested':
      return {
        ts: e.created_at,
        kind: 'review_requested',
        actor: e.review_requester?.login ?? '',
        text: `asked ${e.requested_reviewer?.login ?? 'someone'} for review`,
      }
    case 'merged':
      return { ts: e.created_at, kind: 'merged', actor: e.actor?.login ?? '', text: 'merged the PR' }
    case 'closed':
      return { ts: e.created_at, kind: 'closed', actor: e.actor?.login ?? '', text: 'closed the PR' }
    case 'reopened':
      return { ts: e.created_at, kind: 'reopened', actor: e.actor?.login ?? '', text: 'reopened the PR' }
    case 'head_ref_force_pushed':
      return { ts: e.created_at, kind: 'force_pushed', actor: e.actor?.login ?? '', text: 'force-pushed' }
    default:
      return null
  }
}

// A timeline commit carries only the git author (name, email); `commitAvatars` (sha -> avatar_url,
// from the PR's commit list) is what knows the GitHub account behind it.
export const toTimelineEvent = (
  // biome-ignore lint/suspicious/noExplicitAny: untyped REST payload
  e: any,
  commitAvatars: Map<string, string> = new Map(),
): GhTimelineEvent | null => {
  if (e.event === 'committed') {
    const avatar = commitAvatars.get(e.sha)
    return {
      ts: e.author?.date,
      kind: 'commit',
      actor: e.author?.name ?? '',
      text: (e.message ?? '').split('\n')[0],
      url: e.html_url,
      ...(avatar ? { avatar } : {}),
    }
  }
  const out = toEvent(e)
  const avatar = eventAvatar(e)
  return out && avatar ? { ...out, avatar } : out
}

export const fetchPrTimeline = async (repo: string, prNumber: number): Promise<GhTimelineEvent[]> => {
  const [raw, commits] = await Promise.all([
    gh(['api', `repos/${repo}/issues/${prNumber}/timeline?per_page=100`]).then(JSON.parse),
    // pictures only: a failure here costs commit avatars, never the timeline
    gh(['api', `repos/${repo}/pulls/${prNumber}/commits?per_page=100`])
      .then(JSON.parse)
      .catch(() => []),
  ])
  const commitAvatars = new Map<string, string>(
    // biome-ignore lint/suspicious/noExplicitAny: untyped REST payload
    (commits as any[]).filter((c) => c.author?.avatar_url).map((c) => [c.sha, c.author.avatar_url]),
  )
  return (raw as unknown[])
    .map((e) => toTimelineEvent(e, commitAvatars))
    .filter((e): e is GhTimelineEvent => e !== null && Boolean(e.ts))
}

export const approvePr = async (repo: string, prNumber: number) => {
  await gh(['pr', 'review', String(prNumber), '--repo', repo, '--approve'])
}

export const fetchMergeOptions = async (repo: string): Promise<MergeOptions> =>
  parseMergeOptions(
    JSON.parse(
      await gh([
        'repo',
        'view',
        repo,
        '--json',
        'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod',
      ]),
    ) as GhMergeSettings,
  )

// branch deletion is left to the repo's "automatically delete head branches" setting
export const mergePr = async (repo: string, prNumber: number, method: MergeMethod) => {
  await gh(mergeArgs(repo, prNumber, method))
}

export type GhReview = { author: { login?: string; is_bot?: boolean } | null; state: string; submittedAt: string }
export type GhComment = { author: { login?: string } | null; createdAt: string }
// authoredDate survives a rebase (committedDate doesn't), so it's what tells real new work from a replay
export type GhCommit = {
  authoredDate: string
  committedDate: string
  messageHeadline: string
  authors: { login?: string; name?: string }[]
}

// Everything said and pushed on a PR, plus the CI verdict — one gh call feeding both the card's
// activity badge and the alert rules.
export type PrExchange = {
  count: number // comments + reviews that aren't mine (my own actions are not "new" to me)
  ciState: CiState
  ciChecks: CiChecks
  conflicts: boolean // GitHub can't merge it as is: its CI usually hasn't run either
  reviews: GhReview[]
  comments: GhComment[]
  commits: GhCommit[]
}

export const fetchPrExchange = async (repo: string, prNumber: number, me: string): Promise<PrExchange> => {
  const out = JSON.parse(
    await gh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'comments,reviews,commits,statusCheckRollup,mergeable',
    ]),
  )
  const notMine = (list?: { author?: { login?: string } }[]) =>
    (list ?? []).filter((c) => c.author?.login !== me).length
  return {
    count: notMine(out.comments) + notMine(out.reviews),
    ciState: rollupToCiState(out.statusCheckRollup ?? []),
    ciChecks: ciChecks(out.statusCheckRollup ?? []),
    conflicts: hasConflicts(out.mergeable),
    reviews: out.reviews ?? [],
    comments: out.comments ?? [],
    commits: out.commits ?? [],
  }
}

// A PR authored by me, as returned by `gh pr list --author @me` (raw shape before classification)
export type GhMyPr = {
  number: number
  title: string
  url: string
  headRefName: string
  createdAt: string
  isDraft: boolean
  state: string // OPEN | CLOSED | MERGED
  mergedAt?: string | null
  closedAt?: string | null
  latestReviews: { author: { login: string; is_bot?: boolean } | null; state: string }[]
  reviewRequests: { login?: string }[] // reviewers with a pending (re-)review request
  statusCheckRollup: { conclusion?: string; status?: string; state?: string }[]
  mergeable?: string // MERGEABLE | CONFLICTING | UNKNOWN
}

// gh's --json flattens every review and comment author to {login}, dropping GitHub's Bot type: a Cursor
// review arrives as "cursor", which isBot can't tell from a person (the REST timeline the feed reads
// says "cursor[bot]", so the two disagreed on every verdict). GraphQL still carries the type, so ask it
// which authors on these PRs are bots — one call per repo, all PRs aliased into it.
export const fetchBotLogins = async (repo: string, prNumbers: number[]): Promise<Set<string>> => {
  const bots = new Set<string>()
  if (!prNumbers.length) return bots
  const [owner, name] = repo.split('/')
  const nodes = 'nodes { author { __typename login } }'
  const prs = prNumbers
    .map((n) => `p${n}: pullRequest(number: ${n}) { reviews(last: 100) { ${nodes} } comments(last: 100) { ${nodes} } }`)
    .join(' ')
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${prs} } }`
  const out = JSON.parse(await gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`]))
  type Node = { author: { __typename: string; login: string } | null }
  type Pr = { reviews?: { nodes: Node[] }; comments?: { nodes: Node[] } } | null
  for (const pr of Object.values((out.data?.repository ?? {}) as Record<string, Pr>)) {
    for (const n of [...(pr?.reviews?.nodes ?? []), ...(pr?.comments?.nodes ?? [])]) {
      if (n.author?.__typename === 'Bot') bots.add(n.author.login)
    }
  }
  return bots
}

const MY_PR_FIELDS =
  'number,title,url,headRefName,createdAt,isDraft,state,mergedAt,closedAt,latestReviews,reviewRequests,statusCheckRollup,mergeable'

const listMyPrsIn = async (repo: string, me: string, state: string, limit: number): Promise<GhMyPr[]> =>
  JSON.parse(
    await gh([
      'pr',
      'list',
      '--repo',
      repo,
      '--author',
      me,
      '--state',
      state,
      '--limit',
      String(limit),
      '--json',
      MY_PR_FIELDS,
    ]),
  )

// Open and recently-closed PRs, asked for separately on purpose. A single `--state all --limit 50`
// is newest-first, so in a busy repo merge history fills the window and pushes long-lived open PRs
// out of it entirely — TinxHQ/wazo-mobile#1651 had been open since May and never reached the board.
// Closed/merged ones only feed the Done column, which keeps just the current day, so 30 is plenty.
export const listMyPrs = async (repo: string, me: string): Promise<GhMyPr[]> => {
  const [open, closed] = await Promise.all([listMyPrsIn(repo, me, 'open', 100), listMyPrsIn(repo, me, 'closed', 30)])
  return [...open, ...closed]
}
