import { Command } from '@tauri-apps/plugin-shell'
import type { StreamItem, StreamPriority } from '../types'
import { errText, logWarn } from './log'
import { columnOf } from './stream'

// Needs you, highest first: each card entering it gets a criticality — local rules for the obvious
// ones, Haiku for the rest, in one call for all the newcomers. A priority I set (👤) is never
// re-rated; Haiku's (🤖) is cleared when the card leaves, so its next visit is rated afresh.
// Fail open: no answer is `normal` — a wrong rank only costs order, never safety.

export type Rating = { priority: StreamPriority; reason: string | null }

const LEVELS: StreamPriority[] = ['urgent', 'high', 'normal', 'low']

export const needsRating = (x: StreamItem) =>
  columnOf(x.status) === 'needs_you' && x.priority === null && x.prioritySource !== 'me'

export const localPriority = (x: StreamItem): Rating | null =>
  x.status === 'failed' ? { priority: 'high', reason: 'The agent failed: nothing moves until you look' } : null

export type RateCard = { title: string; waitsOn: string; excerpt: string; waiting: string }

const MAX_EXCERPT = 1500

const PROMPT = (
  cards: RateCard[],
) => `These tasks are waiting for me on my work board. Rate how urgently each one needs me.
- urgent: someone is blocked on me right now, or something is broken
- high: important and time-sensitive, or the agent can't go on without me
- normal: a regular review
- low: cosmetic, or can wait days

Answer with a JSON array, one {"priority": "urgent" | "high" | "normal" | "low", "reason": "<one short line>"} per task, in order, and nothing else.

${cards
  .map(
    (c, i) =>
      `${i + 1}. ${c.title}\n   waiting on me for: ${c.waitsOn} (since ${c.waiting})\n   agent's last message: ${c.excerpt.slice(0, MAX_EXCERPT).replace(/\s+/g, ' ')}`,
  )
  .join('\n\n')}`

// Haiku's answer → one rating per card; anything off-shape is normal with no reason
export const parsePriorities = (text: string, n: number): Rating[] => {
  const none = Array.from({ length: n }, (): Rating => ({ priority: 'normal', reason: null }))
  const json = text.replace(/^[\s\S]*?(\[[\s\S]*\])[\s\S]*$/, '$1')
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return none
  }
  if (!Array.isArray(v) || v.length !== n) return none
  return v.map((r) => ({
    priority: LEVELS.includes(r?.priority) ? r.priority : 'normal',
    reason: typeof r?.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 200) : null,
  }))
}

export const ratePriorities = async (cards: RateCard[]): Promise<Rating[]> => {
  if (!cards.length) return []
  const none = parsePriorities('', cards.length)
  try {
    const out = await Command.create('claude', [
      '-p',
      PROMPT(cards),
      '--model',
      'haiku',
      '--tools',
      '', // a rating needs no tools
      '--no-session-persistence', // or the rater's own transcript would show up as a session
    ]).execute()
    if (out.code !== 0) {
      logWarn('stream', `priority: claude exited ${out.code}: ${out.stderr?.trim() ?? ''}`)
      return none
    }
    return parsePriorities(out.stdout, cards.length)
  } catch (e) {
    logWarn('stream', `priority: ${errText(e)}`)
    return none
  }
}
