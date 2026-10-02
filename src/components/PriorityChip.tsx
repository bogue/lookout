import type { StreamItem, StreamPriority } from '../types'

const LEVELS: StreamPriority[] = ['urgent', 'high', 'normal', 'low']

const COLOR: Record<StreamPriority, string> = {
  urgent: 'bg-red-500/20 text-red-300',
  high: 'bg-amber-500/20 text-amber-300',
  normal: 'bg-deck-700 text-deck-300',
  low: 'bg-deck-800 text-deck-500',
}

type Props = {
  item: StreamItem
  onSet: (priority: StreamPriority | null) => void // null: hand it back to Haiku
}

// A Needs you card's criticality: 🤖 Haiku's (the reason on hover) or 👤 mine. It is a select: pick a
// level to set it myself — never re-rated after that — or "Let Haiku decide" to hand it back.
export const PriorityChip = ({ item, onSet }: Props) => {
  const p = item.priority
  const mine = item.prioritySource === 'me'
  return (
    <select
      value={p ?? ''}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onSet((e.target.value || null) as StreamPriority | null)}
      aria-label="Priority"
      title={
        p
          ? `${mine ? 'Set by you' : `Haiku: ${item.priorityReason ?? 'no reason given'}`} — click to change`
          : 'Rating… — click to set it yourself'
      }
      className={`cursor-pointer appearance-none rounded px-1 py-0.5 focus:outline-none ${p ? COLOR[p] : 'animate-pulse bg-deck-800 text-deck-500'}`}
    >
      {!p && <option value="">🤖 rating…</option>}
      {LEVELS.map((l) => (
        <option key={l} value={l}>
          {l === p ? `${mine ? '👤' : '🤖'} ${l}` : l}
        </option>
      ))}
      {p && <option value="">Let Haiku decide</option>}
    </select>
  )
}
