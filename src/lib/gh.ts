import { Command } from '@tauri-apps/plugin-shell'
import type { CiState } from '../types'
import { rollupToCiState } from './prboard'

const gh = async (args: string[], cwd?: string): Promise<string> => {
  const out = await Command.create('gh', args, cwd ? { cwd } : undefined).execute()
  if (out.code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${out.stderr}`)
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

export const fetchPrState = async (repo: string, prNumber: number): Promise<'open' | 'merged' | 'closed'> => {
  const out = JSON.parse(await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state']))
  return out.state.toLowerCase() as 'open' | 'merged' | 'closed'
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
}

// biome-ignore lint/suspicious/noExplicitAny: untyped REST payload
const toTimelineEvent = (e: any): GhTimelineEvent | null => {
  switch (e.event) {
    case 'committed':
      return {
        ts: e.author?.date,
        kind: 'commit',
        actor: e.author?.name ?? '',
        text: (e.message ?? '').split('\n')[0],
        url: e.html_url,
      }
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

export const fetchPrTimeline = async (repo: string, prNumber: number): Promise<GhTimelineEvent[]> => {
  const raw = JSON.parse(await gh(['api', `repos/${repo}/issues/${prNumber}/timeline?per_page=100`]))
  // biome-ignore lint/suspicious/noExplicitAny: untyped REST payload
  return (raw as any[]).map(toTimelineEvent).filter((e): e is GhTimelineEvent => e !== null && Boolean(e.ts))
}

export const approvePr = async (repo: string, prNumber: number) => {
  await gh(['pr', 'review', String(prNumber), '--repo', repo, '--approve'])
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
  reviews: GhReview[]
  comments: GhComment[]
  commits: GhCommit[]
}

export const fetchPrExchange = async (repo: string, prNumber: number, me: string): Promise<PrExchange> => {
  const out = JSON.parse(
    await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'comments,reviews,commits,statusCheckRollup']),
  )
  const notMine = (list?: { author?: { login?: string } }[]) =>
    (list ?? []).filter((c) => c.author?.login !== me).length
  return {
    count: notMine(out.comments) + notMine(out.reviews),
    ciState: rollupToCiState(out.statusCheckRollup ?? []),
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
}

const MY_PR_FIELDS =
  'number,title,url,headRefName,createdAt,isDraft,state,mergedAt,closedAt,latestReviews,reviewRequests,statusCheckRollup'

const listMyPrsIn = async (repo: string, me: string, state: string, limit: number): Promise<GhMyPr[]> =>
  JSON.parse(
    await gh(['pr', 'list', '--repo', repo, '--author', me, '--state', state, '--limit', String(limit), '--json',
      MY_PR_FIELDS]),
  )

// Open and recently-closed PRs, asked for separately on purpose. A single `--state all --limit 50`
// is newest-first, so in a busy repo merge history fills the window and pushes long-lived open PRs
// out of it entirely — TinxHQ/wazo-mobile#1651 had been open since May and never reached the board.
// Closed/merged ones only feed the Done column, which keeps just the current day, so 30 is plenty.
export const listMyPrs = async (repo: string, me: string): Promise<GhMyPr[]> => {
  const [open, closed] = await Promise.all([
    listMyPrsIn(repo, me, 'open', 100),
    listMyPrsIn(repo, me, 'closed', 30),
  ])
  return [...open, ...closed]
}
