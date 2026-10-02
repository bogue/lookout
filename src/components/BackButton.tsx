import { Tip } from './Tip'
// Back inside a side panel (an overlay back to the panel under it) — closing the panel itself is
// CloseButton
export const BackButton = ({ onClick, title }: { onClick: () => void; title: string }) => (
  <Tip label={title}>
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      className="mr-[3px] cursor-pointer rounded border border-deck-600 px-2 py-1 text-sm text-deck-300 hover:bg-deck-800 hover:text-deck-100"
    >
      ←
    </button>
  </Tip>
)
