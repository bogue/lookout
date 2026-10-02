import { useEffect, useMemo, useRef, useState } from 'react'
import { avatarUrl } from '../lib/avatar'
import { BOARD_STAGES, STAGE_LABEL } from '../lib/stages'
import type { ReviewTask } from '../types'
import { Tip } from './Tip'

type Props = {
  tasks: ReviewTask[]
  onOpen: (t: ReviewTask) => void
  onReview: (id: string) => void
  onWatch: (id: string) => void
  onIgnore: (id: string) => void
  onUnignore: (id: string) => void
}

const btn = 'cursor-pointer rounded px-2 py-1 text-xs'

const SearchIcon = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
)

export const GlobalSearch = ({ tasks, onOpen, onReview, onWatch, onIgnore, onUnignore }: Props) => {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false) // the icon expands into a popover holding the input
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // ⌘K opens the search from anywhere (and re-selects the query when it is already open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // the input only mounts once the popover opens, so focus it then
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // dismiss when clicking outside; the query is kept so reopening shows the same results
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (!q) return []
    return tasks
      .filter((t) =>
        [t.prTitle, t.repo, t.branch, t.prAuthor, `#${t.prNumber}`].some((f) => f.toLowerCase().includes(q)),
      )
      .slice(0, 8)
  }, [tasks, q])

  const reset = () => {
    setQuery('')
    setOpen(false)
  }

  const act = (fn: () => void) => {
    fn()
    reset()
  }

  return (
    <div ref={wrapRef} className="relative">
      <Tip label="Search cards  ⌘K">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label="Search cards"
          aria-expanded={open}
          className={`flex cursor-pointer items-center rounded-md p-1.5 ${open ? 'bg-deck-700 text-white' : 'text-deck-400 hover:text-deck-200'}`}
        >
          <SearchIcon />
        </button>
      </Tip>
      {open && (
        // full-screen blur behind the popover, like the notifications panel. It sits inside wrapRef, so the
        // outside-mousedown listener ignores it: its own click closes.
        // biome-ignore lint/a11y/noStaticElementInteractions: click-away backdrop
        // biome-ignore lint/a11y/useKeyWithClickEvents: click-away backdrop; Esc is handled by the input
        <div onClick={() => setOpen(false)} className="fixed inset-0 z-20 bg-black/30 backdrop-blur-sm" />
      )}
      {open && (
        <div className="absolute right-0 top-full z-40 mt-[9px] w-[550px] max-w-[calc(100vw-2rem)] rounded-md border border-deck-700 bg-deck-900 shadow-xl">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && reset()}
            placeholder="Search cards…"
            className="w-full rounded-t-md border-b border-deck-700 bg-deck-800/80 px-4 py-3 text-base text-deck-100 placeholder:text-deck-500 focus:outline-none"
          />
          {q && (
            <div className="max-h-96 overflow-y-auto py-1">
              {results.length === 0 && <p className="px-3 py-2 text-sm text-deck-500">No cards found</p>}
              {results.map((t) => {
                const inBoard = BOARD_STAGES.includes(t.stage)
                return (
                  <div key={t.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-deck-800">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-deck-100">{t.prTitle}</p>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-deck-400">
                        <img src={avatarUrl(t.prAuthor)} alt={t.prAuthor} className="h-3.5 w-3.5 rounded-full" />
                        <span className="truncate">{t.prAuthor}</span>
                        <span className="shrink-0">
                          {t.repo.split('/')[1]}#{t.prNumber}
                        </span>
                        <span className="shrink-0 rounded bg-deck-700 px-1 py-0.5">{STAGE_LABEL[t.stage]}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {inBoard ? (
                        <Tip label="Go to board + open the card">
                          <button
                            type="button"
                            onClick={() => act(() => onOpen(t))}
                            className={`${btn} bg-grass-600 hover:bg-grass-500`}
                          >
                            Open
                          </button>
                        </Tip>
                      ) : t.stage === 'ignored' ? (
                        <button
                          type="button"
                          onClick={() => act(() => onUnignore(t.id))}
                          className={`${btn} bg-deck-700 hover:bg-deck-600`}
                        >
                          Unignore
                        </button>
                      ) : (
                        <>
                          <Tip label="Add to board + start /do-review now">
                            <button
                              type="button"
                              onClick={() => act(() => onReview(t.id))}
                              className={`${btn} bg-grass-600 hover:bg-grass-500`}
                            >
                              Review
                            </button>
                          </Tip>
                          <button
                            type="button"
                            onClick={() => act(() => onWatch(t.id))}
                            className={`${btn} border border-grass-600 text-grass-300 hover:bg-grass-600/20`}
                          >
                            Watch
                          </button>
                          <button
                            type="button"
                            onClick={() => act(() => onIgnore(t.id))}
                            className={`${btn} bg-deck-700 hover:bg-deck-600`}
                          >
                            Ignore
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
