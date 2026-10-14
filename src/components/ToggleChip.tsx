// A board's "show …" switch, beside its filters: shaped like a filter button, a small switch on its right
export const ToggleChip = ({
  label,
  count,
  on,
  onToggle,
}: {
  label: string
  count: number
  on: boolean
  onToggle: () => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    onClick={onToggle}
    className={`flex cursor-pointer items-center gap-2 rounded-md border py-1 pr-1.5 pl-2.5 text-xs ${
      on ? 'border-grass-600 bg-grass-600/20 text-grass-300' : 'border-deck-600 text-deck-300 hover:bg-deck-700'
    }`}
  >
    {label}
    <span className="rounded-full bg-deck-700/60 px-1.5 text-[10px] leading-4 text-deck-400">{count}</span>
    <span
      className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors duration-200 ${on ? 'bg-grass-500' : 'bg-deck-600'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform duration-200 ${on ? 'translate-x-2.5' : ''}`}
      />
    </span>
  </button>
)
