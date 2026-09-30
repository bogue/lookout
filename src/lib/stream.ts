import type { StreamColumn, StreamItem, StreamPriority, StreamStatus } from '../types'

// The Stream board's pure rules: which column a status sits in, the order inside a column, what a
// drag or a menu action does. Plan: AI_TASKS/2026-09-29-stream-tab.md.

// hint doubles as the column's tooltip: what a card in it actually means
export const STREAM_COLUMNS: { value: StreamColumn; label: string; hint: string }[] = [
  { value: 'inbox', label: 'Inbox', hint: 'Dumped ideas, not queued yet.' },
  { value: 'queued', label: 'Queued', hint: 'Waiting for a free slot. The top card is picked first.' },
  { value: 'active', label: 'Active', hint: 'An agent is running it, or it is watching GitHub for its next step.' },
  { value: 'needs_you', label: 'Needs you', hint: 'Waiting on my approval, an answer, or a retry.' },
  { value: 'done', label: 'Done', hint: 'Finished or skipped.' },
]

const COLUMN_OF: Record<StreamStatus, StreamColumn> = {
  idea: 'inbox',
  shaping: 'inbox',
  queued: 'queued',
  paused: 'queued',
  running: 'active',
  watching: 'active',
  needs_review: 'needs_you',
  question: 'needs_you',
  failed: 'needs_you',
  interrupted: 'needs_you',
  done: 'done',
  skipped: 'done',
}

export const columnOf = (status: StreamStatus): StreamColumn => COLUMN_OF[status]

export const STATUS_LABEL: Record<StreamStatus, string> = {
  idea: 'idea',
  shaping: 'shaping',
  queued: 'queued',
  paused: 'paused',
  running: 'running',
  watching: 'watching',
  needs_review: 'review',
  question: 'question',
  failed: 'failed',
  interrupted: 'interrupted',
  done: 'done',
  skipped: 'skipped',
}

const PRIORITY_RANK: Record<StreamPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

// Order for cards I never dragged, per column: what "first" means there.
const byDefault: Record<StreamColumn, (a: StreamItem, b: StreamItem) => number> = {
  inbox: (a, b) => a.createdAt.localeCompare(b.createdAt), // dump order, so a split dump reads 1, 2, 3
  queued: (a, b) => a.createdAt.localeCompare(b.createdAt), // dump order: next picked first
  active: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  // highest criticality first, then whoever has waited on me the longest
  needs_you: (a, b) =>
    PRIORITY_RANK[a.priority ?? 'normal'] - PRIORITY_RANK[b.priority ?? 'normal'] ||
    a.updatedAt.localeCompare(b.updatedAt),
  done: (a, b) => b.updatedAt.localeCompare(a.updatedAt), // most recently finished first
}

// A column's cards, top first: my drag ranks (sortOrder) win, unranked cards follow the default order.
export const sortColumn = (items: StreamItem[], column: StreamColumn): StreamItem[] =>
  items
    .filter((x) => columnOf(x.status) === column)
    .sort((a, b) => {
      if (a.sortOrder !== null && b.sortOrder !== null) return a.sortOrder - b.sortOrder
      if (a.sortOrder !== null) return -1
      if (b.sortOrder !== null) return 1
      return byDefault[column](a, b)
    })

// The rank a card gets when a status change moves it into another column. Only Done wants newcomers
// on top ("most recently finished first"): once I've dragged something there every card is ranked, and
// an unranked newcomer would otherwise sink below them all. Everywhere else unranked is right — the
// bottom of Inbox/Queued is dump order, and Needs you orders newcomers by criticality.
export const entryRank = (items: StreamItem[], to: StreamStatus): number | null => {
  if (columnOf(to) !== 'done') return null
  const ranks = items.flatMap((x) => (columnOf(x.status) === 'done' && x.sortOrder !== null ? [x.sortOrder] : []))
  return ranks.length ? Math.min(...ranks) - 10 : null
}

// Whether dropping card `id` before `beforeId` (null = the end) leaves the column as it is: over
// itself, just above the card after it, or at the end while already last. Such a drop writes nothing.
export const isNoMove = (column: StreamItem[], id: string, beforeId: string | null): boolean => {
  const idx = column.findIndex((x) => x.id === id)
  if (idx < 0) return false // coming from another column: always a real move
  if (beforeId === null) return idx === column.length - 1
  const beforeIdx = column.findIndex((x) => x.id === beforeId)
  return beforeIdx === idx || beforeIdx === idx + 1
}

// The status a card gets when dropped on `to`: its own for a reorder, the new one for a move that
// makes sense, null to snap it back.
export const dropStatus = (from: StreamStatus, to: StreamColumn): StreamStatus | null => {
  if (columnOf(from) === to) return from
  if (from === 'idea' && to === 'queued') return 'queued'
  if ((from === 'queued' || from === 'paused') && to === 'inbox') return 'idea'
  if ((from === 'queued' || from === 'paused') && to === 'done') return 'skipped'
  return null
}

export type StreamActionId =
  | 'queue'
  | 'pause'
  | 'resume'
  | 'to-inbox'
  | 'done'
  | 'skip'
  | 'requeue'
  | 'top'
  | 'bottom'
  | 'reset-priority'
  | 'remove'

export type StreamAction = { id: StreamActionId; label: string; title?: string; danger?: boolean }

const A: Record<StreamActionId, StreamAction> = {
  queue: { id: 'queue', label: 'Queue', title: 'Move to Queued' },
  pause: { id: 'pause', label: 'Pause', title: 'Keep it queued, but never pick it' },
  resume: { id: 'resume', label: 'Resume', title: 'Pickable again' },
  'to-inbox': { id: 'to-inbox', label: 'Back to Inbox' },
  done: { id: 'done', label: 'Mark done' },
  skip: { id: 'skip', label: 'Skip', title: 'Move to Done without doing it' },
  requeue: { id: 'requeue', label: 'Re-queue' },
  top: { id: 'top', label: 'Move to top' },
  bottom: { id: 'bottom', label: 'Move to bottom' },
  'reset-priority': {
    id: 'reset-priority',
    label: 'Reset priority',
    title: 'Drop my manual rank: it follows the default order again, after the cards I placed by hand',
  },
  remove: { id: 'remove', label: 'Remove', danger: true },
}

const STATUS_ACTIONS: Record<StreamStatus, StreamActionId[]> = {
  idea: ['queue', 'skip'],
  shaping: ['skip'],
  queued: ['pause', 'to-inbox', 'done', 'skip'],
  paused: ['resume', 'to-inbox', 'skip'],
  running: [],
  watching: ['skip'],
  needs_review: ['done', 'skip', 'requeue'],
  question: ['skip'],
  failed: ['requeue', 'done', 'skip'],
  interrupted: ['requeue', 'done', 'skip'],
  done: ['requeue'],
  skipped: ['requeue'],
}

// The quick actions of a card: its status moves, then ordering, then remove. A running card has
// none — its run owns it (cancel lives on the run).
export const streamActions = (x: StreamItem): StreamAction[] => {
  if (x.status === 'running') return []
  const ids: StreamActionId[] = [
    ...STATUS_ACTIONS[x.status],
    'top',
    'bottom',
    ...(x.sortOrder !== null ? (['reset-priority'] as const) : []),
    'remove',
  ]
  return ids.map((id) => A[id])
}

const ACTION_STATUS: Partial<Record<StreamActionId, StreamStatus>> = {
  queue: 'queued',
  pause: 'paused',
  resume: 'queued',
  'to-inbox': 'idea',
  done: 'done',
  skip: 'skipped',
  requeue: 'queued',
}

// the status a menu action moves the card to; null for the ones that only reorder or remove
export const applyStreamAction = (_from: StreamStatus, action: StreamActionId): StreamStatus | null =>
  ACTION_STATUS[action] ?? null

// a column's ids with one card moved to the top or the bottom
export const movedIds = (column: StreamItem[], id: string, to: 'top' | 'bottom'): string[] => {
  const rest = column.filter((x) => x.id !== id).map((x) => x.id)
  return to === 'top' ? [id, ...rest] : [...rest, id]
}

// a `pr` reference (owner/repo#n) as the PR it names
export const prRefOf = (ref: string): { repo: string; number: number; url: string } | null => {
  const m = ref.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/)
  if (!m) return null
  return { repo: m[1], number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` }
}

export type DumpItem = { title: string; refKind: StreamItem['refKind']; ref: string | null }

// "in one branch", "together", "same PR": the list is one piece of work, don't split it
const KEEP_TOGETHER = /\b(in one branch|one branch|same branch|together|same pr|one pr)\b/i
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/
// a target is a whole token: `1.2` and `1,000` are numbers, not the lists "1, 2" and "1, 000"
const TARGET = String.raw`(?<![\w.])(?:#?\d+|[A-Za-z]+-\d+)(?![\w.])`
const SEP = String.raw`(?:\s*,\s*|\s*,?\s+(?:and|&)\s+)`
const TARGET_LIST = new RegExp(`${TARGET}(?:${SEP}${TARGET})+`)
// a bare number list only counts after a work noun ("card 1,2", "bugs 3 and 4") — not dates or amounts
const WORK_NOUN = /\b(?:cards?|items?|tasks?|tickets?|issues?|bugs?|prs?|pull requests?|stor(?:y|ies))\s*$/i
const LABELLED = /^(?:#\d+|[A-Za-z]+-\d+)$/ // #2, ITEM-12: a target on its own
const PR_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/
const PR_NUMBER = /(?:^|[\s(])#(\d+)\b/
const ANY_URL = /https?:\/\/\S+/g
const URL_TAIL = /[)\],.;:!?'"]+$/ // sentence punctuation stuck to a pasted link

// one line with a list of targets ("card 1,2,3,4", "ITEM-12 and ITEM-13") → one line per target
const expand = (line: string): string[] => {
  if (KEEP_TOGETHER.test(line)) return [line]
  // match on a copy with the links blanked out (same length), so nothing splits inside a URL
  const masked = line.replace(ANY_URL, (u) => '\u0001'.repeat(u.length))
  const m = masked.match(TARGET_LIST)
  if (!m || m.index === undefined) return [line]
  const before = line.slice(0, m.index)
  const after = line.slice(m.index + m[0].length)
  const targets = m[0].split(new RegExp(SEP)).filter(Boolean)
  if (!targets.every((t) => LABELLED.test(t)) && !WORK_NOUN.test(before)) return [line]
  return targets.map((t) => `${before}${t}${after}`)
}

const refOf = (title: string, repo: string): Pick<DumpItem, 'refKind' | 'ref'> => {
  const url = title.match(PR_URL)
  if (url) return { refKind: 'pr', ref: `${url[1]}#${url[2]}` }
  const other = title.match(ANY_URL)
  if (other) return { refKind: 'url', ref: other[0].replace(URL_TAIL, '') }
  const pr = title.match(PR_NUMBER)
  if (pr) return { refKind: 'pr', ref: `${repo}#${pr[1]}` }
  return { refKind: null, ref: null }
}

// A dump → the items it asks for: one per line, and one per target when a line lists several,
// unless I said they go together. `repo` is the picked project, for bare #numbers.
export const parseDump = (text: string, repo: string): DumpItem[] =>
  text
    .split('\n')
    .map((l) => l.replace(BULLET, '').trim())
    .filter(Boolean)
    .flatMap(expand)
    .map((title) => ({ title, ...refOf(title, repo) }))
