import type { FlowTemplate, TemplateStep } from './lib/streamflow'
import type { WaitFor } from './lib/streamwatch'
import type { Watcher } from './lib/streamwatchers'

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

export type CiState = 'pass' | 'fail' | 'pending' | 'neutral' | null // neutral: only neutral/skipped checks
export type CiChecks = { failed: number; total: number } | null // null = no checks, or not counted yet

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
  ciChecks: CiChecks
  conflicts: boolean // GitHub can't merge it as is (and its CI usually hasn't run)
  approved: boolean // at least one human reviewer approved (a ✓ before the title)
  activityCount: number | null // human comments + reviews that aren't mine; null until first fetched
  doneAt: string | null // mergedAt / closedAt; Done keeps only the current day's cards
  snoozed: boolean // hidden until GitHub reports something new about the PR (myprs.ts)
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
  ciState: CiState
  ciChecks: CiChecks
  conflicts: boolean // GitHub can't merge it as is (and its CI usually hasn't run)
  approved: boolean // at least one human reviewer approved (a ✓ before the title)
  hasNewActivity: boolean
  snoozed: boolean
  seen: boolean // acknowledged in Discovery (clears the "new" highlight and drops it from the count)
  sortOrder: number | null
  doneAt: string | null
  updatedAt: string
}

// A review Lookout had to recover itself, because the session that produced it exported no file:
// the final assistant turn of a review session, or a body/path handed over by the `lookout` CLI.
// Display only — a captured review never feeds alerts.ts and never moves a card.
export type CapturedReview = {
  id: string // the session id, or "file:<abs path>" for a reference the CLI registered
  kind: 'review' | 'followup' // what the session was doing — the feed says which one it is showing
  taskId: string
  branch: string
  source: 'sync' | 'hook' | 'cli'
  sessionId: string | null
  filePath: string | null // when set, the file is the truth and `body` is null
  body: string | null
  createdAt: string
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
  // review board only: store the run's final answer on the card as a report of this kind.
  // Unset = auto-detect (the prompt's slash command, else Haiku); 'off' = never.
  saveReport?: 'review' | 'followup' | 'off'
}

// a `gh pr merge` strategy, and the Settings preference ('github' = my default on GitHub's merge button)
export type MergeMethod = 'merge' | 'squash' | 'rebase'
export type MergePreference = MergeMethod | 'github'

export type Config = {
  githubUser: string // GitHub login (e.g. chartrandf)
  githubName: string // GitHub profile / git author name (e.g. Francis Chartrand) — used to match my commits
  repos: WatchedRepo[]
  reviewButtons: ActionButton[]
  prButtons: ActionButton[]
  animations: boolean // motion effects (running glow/sheen); colors stay either way
  logging: boolean // write errors to the debug log file (see src/lib/log.ts)
  captureReviews: boolean // recover a review from the session transcript when the skill exported no file
  openInBrowser: boolean // links open in the default browser instead of the in-app window (prwindow.ts)
  notifications: boolean // OS notifications for new alerts; the OS permission is asked when it's switched on
  mergeMethod: MergePreference // the Merge button's default strategy, when the repo allows it
  streamEnabled: boolean // Stream beta (Settings): off = no tab, nothing scheduled, no chips on PR cards
  streamAutoRun: boolean // Stream: agents pick queued cards on their own (off = only Run now starts one)
  streamTemplates: FlowTemplate[] // Stream flow templates (Settings → Stream)
  streamWatchers: Watcher[] // Stream watchers: rules that create cards (Settings → Stream)
}

// Stream: things I dumped for Lookout's agents to work through (src/lib/stream.ts).
//  idea/shaping             Inbox — not queued yet (shaping = an agent is asking me questions)
//  queued/paused            Queued — waiting for a free slot, top first
//  running/watching         Active — an agent is on it, or it waits on GitHub
//  needs_review/question/   Needs you — my approval, an answer, or a retry
//  failed/interrupted
//  done/skipped             Done
export type StreamStatus =
  | 'idea'
  | 'shaping'
  | 'queued'
  | 'paused'
  | 'running'
  | 'watching'
  | 'needs_review'
  | 'question'
  | 'failed'
  | 'interrupted'
  | 'done'
  | 'skipped'

export type StreamColumn = 'inbox' | 'queued' | 'active' | 'needs_you' | 'done'

export type StreamPriority = 'urgent' | 'high' | 'normal' | 'low'

export type StreamItem = {
  id: string
  repo: string // owner/repo — the project the item works in; '' while it isn't known yet
  groupId: string | null // items sharing one branch/worktree ("in one branch")
  title: string
  body: string | null // notes; the dump line itself is the title
  refKind: 'pr' | 'url' | null
  ref: string | null // owner/repo#2, or a Notion/Jira/any URL
  status: StreamStatus
  gate: string | null // what a Needs you item waits on, e.g. project:<status> ("which project?")
  sortOrder: number | null // manual rank within its column; null = the column's default order
  priority: StreamPriority | null // Needs you criticality (Haiku, or set by me)
  priorityReason: string | null
  prioritySource: 'haiku' | 'me' | null
  branch: string | null // the branch its agent works on, once a run prepared it
  checkout: string | null // the worktree path its runs use
  sessionIds: string[] // Claude sessions run for it, oldest first
  waitFor: WaitFor | null // Watching: what on GitHub it waits for (streamwatch.ts)
  steps: TemplateStep[] // its flow's steps (streamflow.ts); none = a one-step card
  stepIndex: number // the step it is on
  templateId: string | null // the flow template it came from
  guidelines: string | null // the template's rules, appended to every step
  createdBy: string // me | cli | watcher:<id>
  createdAt: string
  updatedAt: string
}

// the audit trail of an item: who did what, shown as its feed
export type StreamEvent = {
  id: number
  itemId: string
  ts: string
  actor: string // me | lookout | github | cli | watcher:<id>
  kind: string // created | status | edited | priority | …
  text: string | null
}
