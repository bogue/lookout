import type { CiState, MyPr, PrColumn, PrState, ReviewFlavor } from '../types'
import type { GhMyPr } from './gh'

// Collapse a statusCheckRollup array into a single CI verdict (fail > pending > pass; empty = null).
// Pure so both the classifier and gh.ts (fetchPrExchange) share one source of truth.
export const rollupToCiState = (checks: { conclusion?: string; status?: string; state?: string }[]): CiState => {
  if (!checks.length) return null
  const states = checks.map((c) => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (states.some((s) => s === 'FAILURE' || s === 'ERROR')) return 'fail'
  if (states.some((s) => s === '' || s === 'PENDING' || s === 'IN_PROGRESS' || s === 'QUEUED')) return 'pending'
  return 'pass'
}

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

// GitHub's verdict on where a PR belongs. This is only ever an *input* — what the board shows comes
// from resolveColumn (prcolumns.ts), which moves a card forward and only when this verdict changes.
//
// Bot reviews deliberately don't appear here. A Cursor/Sonar review is lint: the author's problem to
// clear, not a step in the review process — the same reading alerts.ts has always taken
// (`lastHumanReview` skips bots). They'd also be corrosive under a forward-only rule, since a bot
// reviews within minutes of every push and would strand every PR in In Review forever. The card
// still shows the 🤖 badge either way.
export const classifyColumn = (pr: {
  state: PrState
  isDraft: boolean
  humanReview: ReviewFlavor
}): PrColumn => {
  if (pr.state !== 'open') return 'done' // merged or closed: dealt with
  if (pr.isDraft) return 'waiting'
  // a human approval (with no outstanding change request) means "ready — I decide whether to merge"
  if (pr.humanReview === 'approved') return 'ready'
  if (pr.humanReview !== null) return 'in_review'
  return 'waiting'
}

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
    doneAt: raw.mergedAt ?? raw.closedAt ?? null,
  }
}
