import { type DragEvent, type MouseEvent, type ReactNode, useCallback, useState } from 'react'
import { avatarUrl } from '../lib/avatar'
import type { CardAction, CardActionId } from '../lib/cardactions'
import { CardMenuPopover, MENU_WIDTH } from './CardMenu'

type Props = {
  title: string
  author: string
  repo: string // owner/repo
  prNumber: number
  approved?: boolean // a human reviewer approved: a green check before the title
  wide?: boolean // full-width layout (Discovery focus mode): repo#number sits under the action row
  className?: string // extra classes layered on the base card style
  onClick?: (e: MouseEvent) => void
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: () => void
  children?: ReactNode // the tag row
  // quick actions: a ⋯ on hover and a right-click open the same menu
  menu?: CardMenu
}

export type CardMenu = { actions: CardAction[]; onSelect: (id: CardActionId) => void }

const BASE =
  'group relative cursor-pointer rounded-lg border border-deck-700 bg-deck-800/80 p-3 transition-all duration-150 hover:border-deck-600 hover:bg-white/10'

// Shared presentational card shell: title, author + repo#number row, and a tag-row slot.
// Used by the Reviews board and the Pull Requests board so both cards read identically.
export const CardFrame = ({
  title,
  author,
  repo,
  prNumber,
  approved,
  wide,
  className,
  onClick,
  draggable,
  onDragStart,
  onDragEnd,
  children,
  menu,
}: Props) => {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: card body is a mouse affordance; actions inside are buttons
    // biome-ignore lint/a11y/noStaticElementInteractions: card body is a mouse/drag affordance
    <div
      onClick={onClick}
      onContextMenu={
        menu
          ? (e) => {
              e.preventDefault()
              setMenuAt({ x: e.clientX, y: e.clientY })
            }
          : undefined
      }
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`${BASE} ${className ?? ''}`}
    >
      {menu && (
        <button
          type="button"
          title="Quick actions"
          // the popover closes on any outside mousedown; this one is the toggle, not "outside"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            setMenuAt(menuAt ? null : { x: r.right - MENU_WIDTH, y: r.bottom + 4 })
          }}
          className={`card-menu-btn absolute top-2 right-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-deck-600 bg-deck-800 text-sm leading-none text-deck-300 hover:bg-deck-700 ${
            menuAt ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          ⋯
        </button>
      )}
      {menu && menuAt && <CardMenuPopover at={menuAt} onClose={closeMenu} {...menu} />}
      <p className={`text-sm font-medium leading-snug ${menu ? 'pr-7' : ''}`}>
        {approved && (
          <span title="Approved" className="mr-1 text-grass-400">
            ✓
          </span>
        )}
        {title}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-deck-400">
        <img src={avatarUrl(author)} alt={author} className="h-4 w-4 rounded-full" />
        <span className="truncate font-medium text-deck-300">{author}</span>
        {!wide && (
          <span className="ml-auto shrink-0">
            {repo.split('/')[1]}#{prNumber}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-deck-400">{children}</div>
      {wide && (
        <p className="mt-1.5 text-right text-xs text-deck-400">
          {repo.split('/')[1]}#{prNumber}
        </p>
      )}
    </div>
  )
}
