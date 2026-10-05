import type { Stage } from '../types'

// The label the UI shows for each stage, in the order menus list them. Single source of truth: the
// board columns, the card's stage picker, global search and the Settings action editor all read from
// here — nothing renders a raw stage id. A Record, so a new Stage can't be forgotten.
export const STAGE_LABEL: Record<Stage, string> = {
  discovered: 'Discovery',
  watching: 'Watching',
  needs_review: 'Needs Review',
  reviewing: 'In Review',
  reviewed: 'Reviewed',
  followup: 'Follow-up',
  done: 'Done',
  ignored: 'Ignored',
}

// Same thing as a list, for the pickers that render every stage as an option.
export const STAGES = (Object.keys(STAGE_LABEL) as Stage[]).map((value) => ({ value, label: STAGE_LABEL[value] }))

// Ignore case, spaces and dashes, so "Needs Review", "needs-review" and "needsreview" are one key.
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// Stage ids that were renamed. Kept forever so a saved config, an old script or a skill written
// against the previous name keeps working — migration 012 rewrites the database, but nothing can
// rewrite what someone typed into a shell alias.
export const LEGACY_STAGE_IDS: Record<string, Stage> = { inbox: 'needs_review' }

// Read a stage from whatever someone typed: the id the database stores ("needs_review"), the name
// the board shows ("Needs Review"), or a retired id.
export const parseStage = (input: string): Stage | null => {
  const key = normalize(input)
  const listed = STAGES.find((s) => normalize(s.value) === key || normalize(s.label) === key)
  if (listed) return listed.value
  return Object.entries(LEGACY_STAGE_IDS).find(([old]) => normalize(old) === key)?.[1] ?? null
}

// The stages that get a column on the review board — Discovery and Ignored live off it.
export const BOARD_STAGES: Stage[] = ['watching', 'needs_review', 'reviewing', 'reviewed', 'followup', 'done']

// How far along the review pipeline each stage sits. Off-board stages rank below the pipeline.
const RANK: Record<Stage, number> = {
  ignored: -1,
  discovered: 0,
  watching: 1,
  needs_review: 2,
  reviewing: 3,
  reviewed: 4,
  followup: 5,
  done: 6,
}

// Automated stage moves are forward-only: a card that already reached follow-up stays there when a
// fresh review runs — having done a first round is a fact the button shouldn't undo.
export const advanceStage = (current: Stage, target: Stage): Stage => (RANK[target] > RANK[current] ? target : current)

const DONE_TTL_MS = 24 * 60 * 60 * 1000

// Done keeps a finished PR for 24h after it merged or closed. An open PR stays: it still has to be merged.
export const doneExpired = (t: { stage: Stage; prState: string; doneAt: string | null }, now: number): boolean =>
  t.stage === 'done' && t.prState !== 'open' && !!t.doneAt && now - new Date(t.doneAt).getTime() > DONE_TTL_MS
