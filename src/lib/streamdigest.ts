import type { StreamItem } from '../types'
import { columnOf } from './stream'

// Stream's notifications come grouped: one every so often for the cards that reached Needs you since
// I last looked, never one per card. A card counts as new from the moment it entered Needs you
// (updatedAt), and stops being new once I was on the board after that or a notification named it.

export const waitingCount = (items: StreamItem[]) => items.filter((x) => columnOf(x.status) === 'needs_you').length

export type DigestMarks = { seenAt: string | null; notifiedAt: string | null }

export const digestOf = (items: StreamItem[], marks: DigestMarks): { title: string; body: string } | null => {
  const since =
    [marks.seenAt, marks.notifiedAt]
      .filter((t): t is string => !!t)
      .sort()
      .at(-1) ?? ''
  const fresh = items.filter((x) => columnOf(x.status) === 'needs_you' && x.updatedAt > since)
  if (!fresh.length) return null
  const n = fresh.length
  return {
    title: 'Stream needs you',
    body: `${n} new ${n === 1 ? 'item is' : 'items are'} waiting for your feedback in Stream`,
  }
}
