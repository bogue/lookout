export type Stage =
  | 'discovered'
  | 'watching'
  | 'ignored'
  | 'needs_review'
  | 'reviewing'
  | 'reviewed'
  | 'followup'
  | 'done'

export type PrState = 'open' | 'merged' | 'closed'

export type CiState = 'pass' | 'fail' | 'pending' | null

// which column a PR I authored lands in on the Pull Requests board
export type PrColumn = 'waiting' | 'in_review' | 'ready' | 'done'

// the latest review verdict from a given side (human or bot); null = none yet
export type ReviewFlavor = 'approved' | 'changes_requested' | 'commented' | null

// a pull request authored by me, as stored in the `my_prs` table
export type MyPr = {
  id: string // owner/repo#number
  repo: string
  repoPath: string | null
  number: number
  title: string
  url: string
  branch: string
  createdAt: string
  state: PrState
  isDraft: boolean
  sortOrder: number | null // manual drag position within a column (null = unranked, drafts sort last)
  column: PrColumn // effective placement — a high-water mark, not a fresh derivation (prcolumns.ts)
  derivedColumn: PrColumn // what classifyColumn last said; `column` only moves when this changes
  humanReview: ReviewFlavor
  botReview: ReviewFlavor // shown as a badge only — bot reviews never move the column
  ciState: CiState
  doneAt: string | null // mergedAt / closedAt; Done keeps only the current day's cards
}

export type FollowupSummary = {
  addressed: number
  partial: number
  pending: number
}

export type ReviewTask = {
  id: string // owner/repo#number
  repo: string
  repoPath: string | null
  branch: string
  prNumber: number
  prTitle: string
  prUrl: string
  prState: PrState
  prAuthor: string
  prCreatedAt: string | null
  isDraft: boolean
  stage: Stage
  column?: PrColumn // only set for my-PR tasks adapted from a MyPr — drives PR-board button conditions
  reviewRequested: boolean
  sessionIds: string[]
  reviewFiles: string[]
  followupSummary: FollowupSummary | null
  activityCount: number | null
  ciState: 'pass' | 'fail' | 'pending' | null
  hasNewActivity: boolean
  snoozed: boolean
  seen: boolean // acknowledged in Discovery (clears the "new" highlight and drops it from the count)
  sortOrder: number | null
  doneAt: string | null
  updatedAt: string
}

// What the bell shows. Alerts are derived from live PR state on every sync — never logged events:
//  addressed     the author pushed real work after my review (merges/rebases don't count)
//  ready_to_send my review session finished but I haven't said anything on GitHub yet
//  awaiting_me   someone reviewed my own PR and I haven't pushed since
//  ci_fail       CI is red on a PR I'm involved in
export type AlertKind = 'addressed' | 'ready_to_send' | 'awaiting_me' | 'ci_fail'

export type Alert = {
  key: string // kind:taskId[:eventTs] — stable across syncs, changes when the driving event changes
  taskId: string
  kind: AlertKind
  title: string
  body: string
  read: boolean
  archived: boolean // hidden by hand — the row is kept so re-deriving can't resurrect this event
  createdAt: string
}

export type WatchedRepo = {
  repo: string // owner/repo
  path: string // local clone path
}

// which board a configurable action button belongs to
export type ButtonBoard = 'review' | 'pr'

// task fields a button's visibility can be gated on (values are matched as strings)
export type ButtonConditionField = 'stage' | 'column' | 'ciState' | 'prState' | 'hasSession'

// one gate: the task's `field` value must be one of `values`. A button ANDs all its conditions.
export type ButtonCondition = {
  field: ButtonConditionField
  values: string[]
}

// a user-defined action button shown in the session panel for a given board.
// `prompt` is sent to `claude -p` (a /slash command or a full prompt); placeholders <pr_id>, <branch_name>.
export type ActionButton = {
  id: string
  label: string
  icon?: string // key into the shared ActionIcon set; defaults to 'play'
  prompt: string
  conditions: ButtonCondition[] // empty = always visible
  advanceTo?: Stage // review board only: move the card to this stage when the run completes
}

export type Config = {
  githubUser: string // GitHub login (e.g. chartrandf)
  githubName: string // GitHub profile / git author name (e.g. Francis Chartrand) — used to match my commits
  repos: WatchedRepo[]
  reviewButtons: ActionButton[]
  prButtons: ActionButton[]
  animations: boolean // motion effects (running glow/sheen); colors stay either way
}
