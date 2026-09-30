import type { CiChecks, CiState, MyPr, PrColumn, PrState, ReviewFlavor } from '../types'
import type { GhMyPr } from './gh'

type Check = { conclusion?: string; status?: string; state?: string }

const checkState = (c: Check) => (c.conclusion || c.state || c.status || '').toUpperCase()
const isFailure = (s: string) => s === 'FAILURE' || s === 'ERROR'

// The checks that actually ran. A neutral finish (a bot like Bugbot with nothing to say) or a skipped
// job says nothing about whether the code passes — and a PR with merge conflicts often has nothing
// else, because its real CI never started. Counting those as green showed ✓ CI on a PR that ran none.
const ran = (checks: Check[]) => checks.filter((c) => !['NEUTRAL', 'SKIPPED'].includes(checkState(c)))

// Collapse a statusCheckRollup array into a single CI verdict (fail > pending > pass). No checks at
// all = null; checks that all finished neutral or skipped = 'neutral' (shown as a gray "~ CI").
// Pure so both the classifier and gh.ts (fetchPrExchange) share one source of truth.
export const rollupToCiState = (checks: Check[]): CiState => {
  if (!checks.length) return null
  const states = ran(checks).map(checkState)
  if (!states.length) return 'neutral'
  if (states.some(isFailure)) return 'fail'
  if (states.some((s) => s === '' || s === 'PENDING' || s === 'IN_PROGRESS' || s === 'QUEUED')) return 'pending'
  return 'pass'
}

// Failed checks out of the ones that ran, for the "✗ CI 4/7" badge; null when none ran.
export const ciChecks = (checks: Check[]): CiChecks => {
  const real = ran(checks)
  if (!real.length) return null
  return { failed: real.filter((c) => isFailure(checkState(c))).length, total: real.length }
}

// One check as the card panel lists it, GitHub's "N failing, M successful checks" box
export type CheckItem = {
  name: string
  state: 'fail' | 'pending' | 'pass' | 'skipped'
  url: string | null
  seconds: number | null // run time, once it finished
}

// the raw statusCheckRollup entry: a CheckRun (Actions, apps) or a legacy StatusContext (Jenkins…)
type RawCheck = Check & {
  name?: string
  workflowName?: string
  context?: string
  detailsUrl?: string
  targetUrl?: string
  startedAt?: string
  completedAt?: string
}

const itemState = (c: Check): CheckItem['state'] => {
  const s = checkState(c)
  if (isFailure(s)) return 'fail'
  if (['NEUTRAL', 'SKIPPED'].includes(s)) return 'skipped'
  if (s === '' || s === 'PENDING' || s === 'IN_PROGRESS' || s === 'QUEUED' || s === 'EXPECTED') return 'pending'
  return 'pass'
}

const ORDER: Record<CheckItem['state'], number> = { fail: 0, pending: 1, pass: 2, skipped: 3 }

// Every check, failing first, named like GitHub does ("Workflow / job")
export const checkList = (checks: RawCheck[]): CheckItem[] =>
  checks
    .map((c) => {
      const start = c.startedAt ? Date.parse(c.startedAt) : Number.NaN
      const end = c.completedAt ? Date.parse(c.completedAt) : Number.NaN
      return {
        name: c.context ?? [c.workflowName, c.name].filter(Boolean).join(' / '),
        state: itemState(c),
        url: c.detailsUrl || c.targetUrl || null,
        seconds: end >= start ? Math.round((end - start) / 1000) : null,
      }
    })
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name))

// "9s", "4m", "3h 2m": GitHub's "Successful in 4m"
export const checkDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// GitHub's `mergeable`: CONFLICTING is the only answer that means "fix the branch first" (UNKNOWN is
// GitHub still computing it, not a conflict)
export const hasConflicts = (mergeable?: string | null): boolean => mergeable === 'CONFLICTING'

// Every PR board column, in order, with the label the UI shows for it. Single source of truth for the
// board's headers and the Settings action editor.
export const PR_COLUMNS: { value: PrColumn; label: string }[] = [
  { value: 'waiting', label: 'Waiting' },
  { value: 'in_review', label: 'In Review' },
  { value: 'ready', label: 'Ready to merge' },
  { value: 'done', label: 'Done' },
]

type ReviewAuthor = { login?: string; is_bot?: boolean } | null
type Review = { author: ReviewAuthor; state: string }

// GitHub's `[bot]` login suffix, or the explicit is_bot flag
export const isBot = (author: ReviewAuthor): boolean =>
  author?.is_bot === true || Boolean(author?.login?.endsWith('[bot]'))

// The latest verdict across a set of reviews: changes_requested wins over approved wins over commented.
// (A single reviewer's latest review is what gh returns in latestReviews, so this collapses multiple reviewers.)
export const reviewFlavor = (reviews: Review[]): ReviewFlavor => {
  if (!reviews.length) return null
  const states = reviews.map((r) => r.state.toUpperCase())
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested'
  if (states.includes('APPROVED')) return 'approved'
  if (states.includes('COMMENTED')) return 'commented'
  return null
}

// At least one human's latest review approves — even if another reviewer requested changes. Drives the
// ✓ before a card's title, which is about "someone signed off", not the overall verdict.
export const hasApproval = (reviews: Review[]): boolean =>
  reviews.some((r) => !isBot(r.author) && r.state.toUpperCase() === 'APPROVED')

// GitHub's verdict on where a PR belongs. This is only ever an *input* — what the board shows comes
// from resolveColumn (prcolumns.ts), which moves a card forward and only when this verdict changes.
//
// Bot reviews deliberately don't appear here. A Cursor/Sonar review is lint: the author's problem to
// clear, not a step in the review process — the same reading alerts.ts has always taken
// (`lastHumanReview` skips bots). They'd also be corrosive under a forward-only rule, since a bot
// reviews within minutes of every push and would strand every PR in In Review forever. The card
// still shows the 🤖 badge either way.
export const classifyColumn = (pr: { state: PrState; isDraft: boolean; humanReview: ReviewFlavor }): PrColumn => {
  if (pr.state !== 'open') return 'done' // merged or closed: dealt with
  if (pr.isDraft) return 'waiting'
  // a human approval (with no outstanding change request) means "ready — I decide whether to merge"
  if (pr.humanReview === 'approved') return 'ready'
  if (pr.humanReview !== null) return 'in_review'
  return 'waiting'
}

// Done holds only the current day's work, so a PR merged or closed before `since` isn't boarded at
// all. Storing it and leaving it to the next pass's prune doesn't work: the listing returns it again
// every sync, so it would be re-added as fast as it's deleted and Done would fill with months of
// merges. `since` is the local start of day (startOfToday).
export const isBoardable = (pr: { state: PrState; doneAt: string | null }, since: string): boolean =>
  pr.state === 'open' || (pr.doneAt !== null && pr.doneAt >= since)

// Map a raw gh PR into the facts the board stores. `column` is only the starting placement for a PR
// we've never seen; for a known one the caller re-resolves it against the stored row (resolveColumn).
export const toMyPr = (raw: GhMyPr, repo: string, repoPath: string | null): MyPr => {
  const state = raw.state.toLowerCase() as PrState

  // a reviewer with a pending (re-)review request has had their prior review superseded — ignore it,
  // so re-requesting review after handling comments clears the stale "commented"/"changes" tag
  const requested = new Set((raw.reviewRequests ?? []).map((r) => r.login).filter(Boolean))
  const active = raw.latestReviews.filter((r) => !(r.author?.login && requested.has(r.author.login)))
  const humanReviews = active.filter((r) => !isBot(r.author))
  const botReviews = active.filter((r) => isBot(r.author))
  const humanReview = reviewFlavor(humanReviews)
  const botReview = reviewFlavor(botReviews)
  const column = classifyColumn({ state, isDraft: raw.isDraft, humanReview })

  return {
    id: `${repo}#${raw.number}`,
    repo,
    repoPath,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    branch: raw.headRefName,
    createdAt: raw.createdAt,
    state,
    isDraft: raw.isDraft,
    sortOrder: null,
    column,
    derivedColumn: column,
    humanReview,
    botReview,
    ciState: rollupToCiState(raw.statusCheckRollup ?? []),
    ciChecks: ciChecks(raw.statusCheckRollup ?? []),
    conflicts: hasConflicts(raw.mergeable),
    approved: hasApproval(humanReviews),
    activityCount: null, // the list call doesn't carry comments; syncMyPrs fills it from the exchange
    doneAt: raw.mergedAt ?? raw.closedAt ?? null,
    snoozed: false, // syncMyPrs carries a stored snooze over
  }
}
