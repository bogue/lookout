import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export type Confirm = {
  title: string
  body: ReactNode
  confirmLabel: string
  onConfirm: () => void
}

// A small in-app confirmation for destructive settings changes (delete an action, reset to defaults):
// the app's own look instead of the OS alert. Esc or a click outside cancels; the confirm button has
// focus, so Enter confirms.
export const ConfirmDialog = ({ confirm, onClose }: { confirm: Confirm; onClose: () => void }) => {
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    confirmRef.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click cancels; Esc is handled above
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled by the document listener
    <div onClick={onClose} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-deck-700 bg-deck-900 p-5 shadow-2xl"
      >
        <h2 id="confirm-title" className="text-base font-semibold text-white">
          {confirm.title}
        </h2>
        <p className="mt-2 text-sm text-deck-400">{confirm.body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md border border-deck-600 px-3 py-1.5 text-sm text-deck-300 hover:bg-deck-700"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => {
              confirm.onConfirm()
              onClose()
            }}
            className="cursor-pointer rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400/60"
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
