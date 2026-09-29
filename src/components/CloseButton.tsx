// Closes a side panel: the same ✕ in every panel header, always its last control, top right
export const CloseButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    title="Close (Esc)"
    aria-label="Close panel"
    className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded border border-deck-600 text-sm text-deck-300 hover:bg-deck-800 hover:text-deck-100"
  >
    ✕
  </button>
)
