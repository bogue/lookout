// The Stream board: things I dumped for Lookout's agents to work through (AI_TASKS/2026-09-29-stream-tab.md).
// Columns only for now — items, the dump composer and the scheduler land in the next phases.

// hint doubles as the column's tooltip: what a card in it actually means
const COLUMNS: { title: string; hint: string }[] = [
  { title: 'Inbox', hint: 'Dumped ideas, not queued yet — shape them with an agent or pick a template.' },
  { title: 'Queued', hint: 'Waiting for a free slot. The top card is picked first.' },
  { title: 'Active', hint: 'An agent is running it, or it is watching GitHub for its next step.' },
  { title: 'Needs you', hint: 'Waiting on my approval, an answer, or a retry.' },
  { title: 'Done', hint: 'Finished or skipped.' },
]

export const Stream = () => (
  <div className="grid h-full min-h-0 grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
    {COLUMNS.map((col) => (
      <div key={col.title} className="flex min-h-0 flex-col gap-2 rounded-lg bg-grass-600/10 p-2">
        <h3
          title={col.hint}
          className="shrink-0 cursor-help px-1 text-xs font-semibold uppercase tracking-wide text-deck-300"
        >
          {col.title} <span className="font-normal text-deck-400">(0)</span>
        </h3>
      </div>
    ))}
  </div>
)
