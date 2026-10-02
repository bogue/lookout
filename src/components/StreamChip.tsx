import { streamChip } from '../lib/stream'
import { waitingLabel } from '../lib/streamwatch'
import type { StreamItem } from '../types'

// On a Reviews / Pull Requests card: a Stream card is working on (or watching) this PR
export const StreamChip = ({ item }: { item: StreamItem | undefined }) =>
  item ? (
    <span
      title={`Stream: “${item.title}”${item.waitFor ? ` — ${waitingLabel(item.waitFor)}` : ''}`}
      className={`rounded px-1 py-0.5 ${item.status === 'running' ? 'animate-pulse bg-amber-500/20 text-amber-300' : 'bg-sky-500/15 text-sky-300'}`}
    >
      {streamChip(item.status)}
    </span>
  ) : null
