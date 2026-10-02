import { useEffect, useRef } from 'react'
import type { IconName } from '../lib/icons'
import type { SessionOption } from '../lib/replytarget'
import { messageTime } from '../lib/time'
import { Icon } from './Icon'

type Props = {
  options: SessionOption[] // the PR's sessions, newest first
  selected: string | null // null = a new chat session
  onSelect: (sessionId: string | null) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

const NEW_ICON: IconName = 'comment-discussion'
const NEW_LABEL = 'New chat session'
const NEW_SHORT = 'Chat' // on the button, where the menu's wording would crowd the composer

// Which session the input talks to, under it: a new chat or one of the PR's sessions. The menu
// opens upward, the input sits at the panel's foot.
export const SessionPicker = ({ options, selected, onSelect, open, onOpenChange }: Props) => {
  const boxRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.sessionId === selected)

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open, onOpenChange])

  const pick = (id: string | null) => {
    onSelect(id)
    onOpenChange(false)
  }

  return (
    <div ref={boxRef} className="relative flex min-w-0">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title={current ? `Messages go to session ${current.sessionId}` : 'Messages start a new chat session'}
        className={`flex min-w-0 max-w-[225px] cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs ${
          current
            ? 'bg-grass-600/25 text-grass-100 hover:bg-grass-600/35'
            : 'bg-deck-700/70 text-deck-200 hover:bg-deck-700'
        } ${open ? 'ring-1 ring-deck-500' : ''}`}
      >
        <Icon name={current ? current.icon : NEW_ICON} size={12} />
        <span className="min-w-0 truncate">{current ? current.label : NEW_SHORT}</span>
        <span className="text-deck-500">⌄</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-1 flex max-h-72 w-80 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-xl border border-deck-700 bg-deck-800 py-1 shadow-lg">
          <button
            type="button"
            onClick={() => pick(null)}
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-deck-200 hover:bg-deck-700"
          >
            <Icon name={NEW_ICON} />
            <span className="flex-1">{NEW_LABEL}</span>
            {selected === null && <span className="text-grass-400">✓</span>}
          </button>
          {options.length > 0 && <div className="my-1 border-t border-deck-700" />}
          {options.map((o) => (
            <button
              key={o.sessionId}
              type="button"
              // picking the selected one again unselects it: back to a new chat
              onClick={() => pick(o.sessionId === selected ? null : o.sessionId)}
              title={o.sessionId}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-deck-200 hover:bg-deck-700"
            >
              <Icon name={o.icon} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.ts && <span className="shrink-0 text-[10px] text-deck-500">{messageTime(o.ts)}</span>}
              <span className="w-3 shrink-0 text-grass-400">{o.sessionId === selected ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
