import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CardAction, CardActionId } from '../lib/cardactions'
import { Tip } from './Tip'

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const ICONS: Record<CardActionId, ReactNode> = {
  snooze: (
    <svg {...iconProps} aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  ),
  resume: (
    <svg {...iconProps} aria-hidden="true">
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  ),
  'open-browser': (
    <svg {...iconProps} aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  ),
  remove: (
    <svg {...iconProps} aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 12h8" />
    </svg>
  ),
  kill: (
    <svg {...iconProps} fill="currentColor" stroke="none" aria-hidden="true">
      <rect width="14" height="14" x="5" y="5" rx="2" />
    </svg>
  ),
}

// one action's icon on its own, for a control that lives outside the menu (the PR panel's snooze)
export const CardActionIcon = ({ id }: { id: CardActionId }) => ICONS[id]

type ListProps = {
  actions: CardAction[]
  onSelect: (id: CardActionId) => void
}

// The rows themselves, shared by the panel's ⋯ dropdown and the card popover.
export const CardMenuList = ({ actions, onSelect }: ListProps) => (
  <>
    {actions.map((a) => (
      <Tip key={a.id} label={a.title}>
        <button
          type="button"
          onClick={() => onSelect(a.id)}
          className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs ${
            a.danger ? 'text-red-300 hover:bg-red-600/20' : 'text-deck-200 hover:bg-deck-700'
          }`}
        >
          {ICONS[a.id]} {a.label}
        </button>
      </Tip>
    ))}
  </>
)

export const MENU_WIDTH = 240

// A card's quick-action menu, pinned at a screen point (under the ⋯, or where the right-click
// landed). Portalled out of the card so it isn't clipped by a scrolling column — but React still
// bubbles its events through the card, so they stop here instead of opening the panel.
export const CardMenuPopover = ({
  at,
  onClose,
  ...list
}: ListProps & { at: { x: number; y: number }; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  // keep it on screen: flip left of the point near the right edge, clamp near the bottom
  const left = Math.min(at.x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(at.y, window.innerHeight - 40 * list.actions.length - 16)
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: swallows the card's click/drag, not an action itself
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the rows and the Escape listener
    <div
      ref={ref}
      style={{ left, top, width: MENU_WIDTH }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      className="fixed z-50 flex flex-col rounded-md border border-deck-700 bg-deck-800 py-1 shadow-xl"
    >
      <CardMenuList
        {...list}
        onSelect={(id) => {
          list.onSelect(id)
          onClose()
        }}
      />
    </div>,
    document.body,
  )
}
