import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CardMenuPopover, MENU_WIDTH } from '../components/CardMenu'
import { type Confirm, ConfirmDialog } from '../components/ConfirmDialog'
import { actorIcon, RefChip, StreamPanel } from '../components/StreamPanel'
import {
  addStreamItems,
  askStreamProject,
  removeStreamItem,
  resetStreamPriority,
  setStreamOrders,
  setStreamProject,
  setStreamStatus,
  streamItems,
} from '../lib/db'
import { logError } from '../lib/log'
import { listSlashEntries, matchSlash, type SlashEntry, slashQuery } from '../lib/skills'
import {
  applyStreamAction,
  columnOf,
  dropStatus,
  entryRank,
  isNoMove,
  movedIds,
  parseDump,
  projectGateTarget,
  STATUS_LABEL,
  STREAM_COLUMNS,
  type StreamActionId,
  sortColumn,
  streamActions,
  tagFor,
  tagQuery,
  tagSuggestions,
} from '../lib/stream'
import { guessProjects } from '../lib/streamproject'
import { notifyStream, onStreamChange, runStreamItem } from '../lib/streamrunner'
import { waitingLabel } from '../lib/streamwatch'
import { timeAgo } from '../lib/time'
import type { StreamColumn, StreamItem, StreamStatus, WatchedRepo } from '../types'

// The Stream board: things I dumped for Lookout's agents to work through (AI_TASKS/2026-09-29-stream-tab.md).
// Manual for now: dump, prioritise by drag, move by hand. Agents pick items up in the next phases.

type Props = {
  repos: WatchedRepo[]
  autoRun: boolean // agents pick queued cards on their own
  onAutoRun: (on: boolean) => void
  openRequest: { id: string; at: number } | null // open this card (a new `at` reopens the same one)
}

// statuses whose column already says it all get no tag
const QUIET: StreamStatus[] = ['idea', 'queued', 'done']

const TAG_CLASS: Partial<Record<StreamStatus, string>> = {
  paused: 'bg-deck-700 text-deck-300',
  skipped: 'bg-deck-700 text-deck-400',
  failed: 'bg-red-500/20 text-red-300',
  interrupted: 'bg-amber-500/20 text-amber-300',
  running: 'animate-pulse bg-amber-500/20 text-amber-300',
  watching: 'bg-sky-500/15 text-sky-300',
}

type CardProps = {
  item: StreamItem
  onOpen: () => void
  onAction: (id: StreamActionId) => void
  onDragStart: () => void
  onDragEnd: () => void
}

const Card = ({ item, onOpen, onAction, onDragStart, onDragEnd }: CardProps) => {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])
  const actions = streamActions(item)
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: card body is a mouse affordance; actions inside are buttons
    // biome-ignore lint/a11y/noStaticElementInteractions: card body is a mouse/drag affordance
    <div
      onClick={onOpen}
      onContextMenu={(e) => {
        if (!actions.length) return
        e.preventDefault()
        setMenuAt({ x: e.clientX, y: e.clientY })
      }}
      draggable={item.status !== 'running'}
      onDragStart={(e) => {
        // WebKit requires setData for the drag to actually start
        e.dataTransfer.setData('text/plain', item.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={`group relative cursor-pointer rounded-lg border border-deck-700 bg-deck-800/80 p-3 transition-all duration-150 hover:border-deck-600 hover:bg-white/10 ${
        item.status === 'paused' || item.status === 'skipped'
          ? 'opacity-60'
          : item.status === 'running'
            ? 'card-running'
            : item.status === 'needs_review'
              ? 'card-awaiting'
              : ''
      }`}
    >
      {actions.length > 0 && (
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
      {menuAt && <CardMenuPopover at={menuAt} onClose={closeMenu} actions={actions} onSelect={onAction} />}
      <p className="line-clamp-3 pr-7 text-sm font-medium leading-snug">{item.title}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-deck-400">
        {item.repo ? (
          <span className="truncate text-deck-300">{item.repo.split('/')[1]}</span>
        ) : projectGateTarget(item.gate) ? (
          <span className="rounded bg-amber-500/20 px-1 py-0.5 text-amber-300">which project?</span>
        ) : (
          <span className="animate-pulse text-deck-500">finding project…</span>
        )}
        <RefChip item={item} />
        {!QUIET.includes(item.status) && !projectGateTarget(item.gate) && (
          <span className={`rounded px-1 py-0.5 ${TAG_CLASS[item.status] ?? 'bg-deck-700'}`}>
            {item.status === 'watching' && item.waitFor ? `👁 ${waitingLabel(item.waitFor)}` : STATUS_LABEL[item.status]}
          </span>
        )}
        <span className="ml-auto shrink-0" title={`created by ${item.createdBy}, ${timeAgo(item.createdAt)}`}>
          {actorIcon(item.createdBy)} {timeAgo(item.createdAt)}
        </span>
      </div>
    </div>
  )
}

const ReturnKey = () => <kbd className="rounded bg-black/20 px-1 font-sans text-[10px] leading-4 text-white/80">⌘↵</kbd>

// The dump: type or paste what I want done, one line each; a list of targets splits into one card
// per target unless I say they go together. `#project` picks the project; with none, "All projects"
// lets Haiku place each card, and the ones it can't place wait in Needs you.
// one row of the caret dropdown: a #project or a /skill
type MenuItem = { key: string; label: string; detail: string | null; insert: string }

const Dump = ({
  repos,
  slash,
  onAdd,
}: {
  repos: WatchedRepo[]
  slash: SlashEntry[] // my skills and commands, for `/`
  onAdd: (text: string, picked: string | null, queue: boolean) => void
}) => {
  const [text, setText] = useState('')
  const [repo, setRepo] = useState('') // '' = All projects
  const [queue, setQueue] = useState(false) // where the cards land: Inbox (false) or Queued
  const [listOpen, setListOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const names = useMemo(() => repos.map((r) => r.repo), [repos])
  // a repo removed from Settings while picked falls back to All; a single project needs no guessing
  const picked = names.includes(repo) ? repo : names.length === 1 ? names[0] : null
  const preview = useMemo(() => parseDump(text, names, picked), [text, names, picked])

  // caret dropdown: `#` lists projects, `/` my skills and commands; Esc hides it for that token only
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const tag = tagQuery(text, caret)
  const cmd = tag ? null : slashQuery(text, caret)
  const at = tag ?? cmd
  const suggestions: MenuItem[] =
    !at || at.start === dismissedAt
      ? []
      : tag
        ? tagSuggestions(tag.query, names).map((r) => ({
            key: r,
            label: `#${r.split('/')[1]}`,
            detail: r,
            insert: `#${tagFor(r, names)} `,
          }))
        : matchSlash(cmd?.query ?? '', slash).map((e) => ({
            key: e.name,
            label: `/${e.name}`,
            detail: e.description,
            insert: `/${e.name} `,
          }))
  const pendingCaret = useRef<number | null>(null)

  // opening Stream is usually to dump something: the text box is ready to type in (once it exists —
  // it only renders when a project is configured, and the config can land after the first paint)
  const hasRepos = repos.length > 0
  useEffect(() => {
    if (hasRepos) inputRef.current?.focus()
  }, [hasRepos])

  // after a pick rewrites the text, put the caret right after the inserted tag
  useEffect(() => {
    if (pendingCaret.current === null || !inputRef.current) return
    inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
    setCaret(pendingCaret.current)
    pendingCaret.current = null
  })

  const pick = (item: MenuItem) => {
    if (!at) return
    setText(`${text.slice(0, at.start)}${item.insert}${text.slice(caret)}`)
    pendingCaret.current = at.start + item.insert.length
    setActive(0)
  }

  const trackCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart)
    setActive(0)
  }

  // the card list closes on any click outside it
  useEffect(() => {
    if (!listOpen) return
    const outside = (e: MouseEvent) => {
      if (!listRef.current?.contains(e.target as Node)) setListOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [listOpen])

  if (!repos.length)
    return <p className="text-sm text-deck-400">Add a project in Settings to start dumping work here.</p>

  const add = () => {
    if (!preview.length) return
    onAdd(text, picked, queue)
    setText('')
    setListOpen(false)
  }

  const lines = text.split('\n').length
  const control = 'h-7 rounded-md text-xs' // every control in the footer row shares this height
  const n = preview.length
  const menuOpen = suggestions.length > 0
  const anyOpen = menuOpen || (listOpen && n > 1)

  return (
    <>
      {/* full-screen blur behind an open dropdown (like search and notifications); the dump itself
          rises above it. mousedown keeps the textarea's focus and caret */}
      {anyOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: click-away backdrop
        <div
          onMouseDown={(e) => {
            e.preventDefault()
            setDismissedAt(at?.start ?? null)
            setListOpen(false)
          }}
          className="fixed inset-0 z-20 bg-black/30 backdrop-blur-sm"
        />
      )}
      <div
        className={`relative flex min-h-[130px] flex-col rounded-lg border border-grass-600/30 bg-grass-600/10 shadow-lg shadow-black/30 transition-colors focus-within:border-grass-500/70 focus-within:ring-1 focus-within:ring-grass-500/70 ${anyOpen ? 'z-30' : ''}`}
      >
        {menuOpen && (
          <div
            role="listbox"
            aria-label={tag ? 'Projects' : 'Skills and commands'}
            className={`absolute bottom-full left-3 z-30 mb-2 max-h-72 ${tag ? 'w-[30rem]' : 'w-[40rem]'} max-w-[calc(100vw-4rem)] overflow-y-auto rounded-lg border border-deck-700 bg-deck-900 py-1 shadow-xl`}
          >
            {suggestions.map((s, i) => (
              <button
                key={s.key}
                type="button"
                role="option"
                aria-selected={i === active}
                // mousedown, not click: the textarea keeps focus and its caret
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(s)
                }}
                onMouseEnter={() => setActive(i)}
                title={s.detail ?? undefined}
                className={`flex w-full cursor-pointer items-baseline gap-4 px-3 py-2 text-left text-sm ${i === active ? 'bg-deck-700' : ''}`}
              >
                <span className="shrink-0 whitespace-nowrap font-medium text-deck-100">{s.label}</span>
                {s.detail && (
                  <span className={`min-w-0 flex-1 truncate text-xs text-deck-500 ${tag ? 'text-right' : ''}`}>
                    {s.detail}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            trackCaret(e.target)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onBlur={() => setDismissedAt(at?.start ?? null)}
          onFocus={() => setDismissedAt(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              add()
              return
            }
            if (!suggestions.length) return
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setActive((a) => (a + step + suggestions.length) % suggestions.length)
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(suggestions[Math.min(active, suggestions.length - 1)])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDismissedAt(at?.start ?? null)
            }
          }}
          rows={Math.min(Math.max(lines, 1), 6)}
          aria-label="What needs to be done"
          placeholder="What needs to be done?  e.g. #my-project implement card 1,2,3,4"
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-4 pt-3 pb-2 text-[17px] leading-relaxed text-deck-100 placeholder:text-deck-500 focus:outline-none"
        />
        <div className="flex items-center gap-2 border-t border-grass-600/20 px-3 py-2">
          <select
            value={names.includes(repo) ? repo : ''}
            onChange={(e) => setRepo(e.target.value)}
            aria-label="Project"
            title="The project of lines with no #project tag"
            className={`${control} max-w-[16rem] cursor-pointer truncate border border-deck-700 bg-deck-800 px-2 text-deck-200 focus:border-deck-500 focus:outline-none`}
          >
            <option value="">All projects</option>
            {repos.map((r) => (
              <option key={r.repo} value={r.repo}>
                {r.repo}
              </option>
            ))}
          </select>
          {/* where the cards land: a setting of the dump, not a second button competing with Add */}
          <fieldset aria-label="Add to" className={`${control} flex border border-deck-700 bg-deck-800 p-0.5`}>
            {(
              [
                [false, 'Inbox', 'Land in Inbox: I decide later'],
                [true, 'Queued', 'Land in Queued: ready to be picked up'],
              ] as const
            ).map(([q, label, title]) => (
              <button
                key={label}
                type="button"
                aria-pressed={queue === q}
                title={title}
                onClick={() => setQueue(q)}
                className={`cursor-pointer rounded px-2.5 ${queue === q ? 'bg-deck-600 text-white' : 'text-deck-400 hover:text-deck-200'}`}
              >
                {label}
              </button>
            ))}
          </fieldset>
          {/* Add, and — when the dump splits — a caret listing the cards it will create */}
          <div ref={listRef} className="relative ml-auto flex">
            <button
              type="button"
              onClick={add}
              disabled={!n}
              className={`flex h-9 cursor-pointer items-center gap-2 rounded-md bg-grass-600 px-4 text-sm font-semibold text-white hover:bg-grass-500 disabled:cursor-default disabled:opacity-40 ${n > 1 ? 'rounded-r-none' : ''}`}
            >
              <ReturnKey />
              {n > 1 ? `Add ${n} cards` : 'Add card'}
            </button>
            {n > 1 && (
              <button
                type="button"
                onClick={() => setListOpen((o) => !o)}
                aria-expanded={listOpen}
                aria-label="Show the cards to create"
                title="Show the cards to create"
                className={`h-9 w-[25px] cursor-pointer rounded-md rounded-l-none text-xs border-l border-grass-700 bg-grass-600 text-white hover:bg-grass-500`}
              >
                {listOpen ? '▴' : '▾'}
              </button>
            )}
            {listOpen && n > 1 && (
              <div className="absolute right-0 bottom-full z-30 mb-2 max-h-80 w-96 overflow-y-auto rounded-lg border border-deck-700 bg-deck-900 py-1 shadow-xl">
                <p className="px-3 py-1.5 text-xs text-deck-500">
                  {n} cards will be {queue ? 'queued' : 'added to your Inbox'}
                </p>
                <ol>
                  {preview.map((d, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no identity yet; two lines may read the same
                    <li key={i} className="flex items-baseline gap-2 px-3 py-1.5 text-sm">
                      <span className="w-4 shrink-0 text-right text-xs text-deck-500">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-deck-100">{d.title}</span>
                      {d.repo && <span className="shrink-0 text-xs text-deck-400">{d.repo.split('/')[1]}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export const Stream = ({ repos, autoRun, onAutoRun, openRequest }: Props) => {
  const [items, setItems] = useState<StreamItem[]>([])
  const [version, setVersion] = useState(0) // bumped after every write: the open panel re-reads its feed
  const [openId, setOpenId] = useState<string | null>(null)
  // a Stream entry clicked in a PR's history (App): open that card here
  useEffect(() => {
    if (openRequest) setOpenId(openRequest.id)
  }, [openRequest])
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [dragging, setDragging] = useState<StreamItem | null>(null)
  const [dropTarget, setDropTarget] = useState<StreamColumn | null>(null)
  // insertion indicator: line above card `before`, or at the column end when before is null
  const [dropLine, setDropLine] = useState<{ col: StreamColumn; before: string | null } | null>(null)

  const reload = useCallback(async () => {
    try {
      setItems(await streamItems())
      setVersion((v) => v + 1)
    } catch (e) {
      logError('stream', e, 'load stream items')
    }
  }, [])

  // the runner writes from outside this view (a run ended, a session started): reload on its feed
  useEffect(() => {
    reload()
    return onStreamChange(reload)
  }, [reload])

  // a write, then the change feed: this view reloads, and Auto-run gets its chance to pick
  const write = async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn()
    } catch (e) {
      logError('stream', e, what)
    }
    notifyStream()
  }

  const names = useMemo(() => repos.map((r) => r.repo), [repos])

  // my skills and commands for the dump's `/` menu: read once per set of projects (they change rarely)
  const [slash, setSlash] = useState<SlashEntry[]>([])
  const paths = repos.map((r) => r.path).join('\n')
  useEffect(() => {
    listSlashEntries(paths ? paths.split('\n') : [])
      .then(setSlash)
      .catch((e) => logError('stream', e, 'list skills'))
  }, [paths])

  const onAdd = (text: string, picked: string | null, queue: boolean) =>
    write(() => addStreamItems(parseDump(text, names, picked), queue ? 'queued' : 'idea'), 'add stream items')

  // Cards with no project yet (repo ''): Haiku places them; the ones it can't wait in Needs you.
  // Runs after every reload, so a guess cut short by quitting the app is simply retried.
  const guessing = useRef(new Set<string>())
  // biome-ignore lint/correctness/useExhaustiveDependencies: write is recreated each render; items is the trigger
  useEffect(() => {
    const pending = items.filter((x) => x.repo === '' && x.status !== 'question' && !guessing.current.has(x.id))
    if (!pending.length || !names.length) return
    for (const x of pending) guessing.current.add(x.id)
    const place = async () => {
      const guesses = await guessProjects(
        pending.map((x) => x.title),
        names,
      )
      await write(async () => {
        for (const [i, x] of pending.entries()) {
          const repo = guesses[i]
          await (repo ? setStreamProject(x, repo, 'lookout') : askStreamProject(x))
        }
      }, 'place stream items')
      for (const x of pending) guessing.current.delete(x.id)
    }
    place()
  }, [items, names])

  const onAction = (item: StreamItem, action: StreamActionId) => {
    if (action === 'run' || action === 'retry') return write(() => runStreamItem(item, repos, 'me'), `stream ${action}`)
    const status = applyStreamAction(item.status, action)
    if (status) return write(() => setStreamStatus(item, status, entryRank(items, status)), `stream ${action}`)
    if (action === 'top' || action === 'bottom') {
      const column = sortColumn(items, columnOf(item.status))
      return write(() => setStreamOrders(movedIds(column, item.id, action)), `stream ${action}`)
    }
    if (action === 'reset-priority') return write(() => resetStreamPriority(item.id), 'stream reset priority')
    if (action === 'remove')
      setConfirm({
        title: 'Remove this item?',
        body: `“${item.title}” and its activity are deleted. This can't be undone.`,
        confirmLabel: 'Remove',
        onConfirm: () => {
          if (openId === item.id) setOpenId(null)
          write(() => removeStreamItem(item.id), 'remove stream item')
        },
      })
  }

  const endDrag = () => {
    setDragging(null)
    setDropTarget(null)
    setDropLine(null)
  }

  // hide the insertion line when dropping there wouldn't move the card
  const noMove = (colItems: StreamItem[], before: StreamItem | null) =>
    !dragging || isNoMove(colItems, dragging.id, before?.id ?? null)

  // drop the dragged card into a column before `before` (or at the end); a move that makes no sense
  // for its status (dropStatus null) snaps back, and one that moves nothing writes nothing — ranking
  // the column would freeze its default order for no reason
  const drop = (colItems: StreamItem[], col: StreamColumn, before: StreamItem | null) => {
    const card = dragging
    const still = noMove(colItems, before)
    endDrag()
    if (!card || still) return
    const status = dropStatus(card.status, col)
    if (!status) return
    const rest = colItems.filter((x) => x.id !== card.id)
    const idx = before ? rest.findIndex((x) => x.id === before.id) : rest.length
    const at = idx < 0 ? rest.length : idx
    const ordered = [...rest.slice(0, at), card, ...rest.slice(at)].map((x) => x.id)
    write(async () => {
      await setStreamStatus(card, status) // no-op for a reorder
      await setStreamOrders(ordered)
    }, 'stream drop')
  }

  const open = items.find((x) => x.id === openId) ?? null

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-end gap-3 text-xs text-deck-400">
        <span>{items.filter((x) => x.status === 'running').length} running</span>
        <button
          type="button"
          role="switch"
          aria-checked={autoRun}
          onClick={() => onAutoRun(!autoRun)}
          title={
            autoRun ? 'Agents pick the top of Queued on their own' : 'Nothing starts on its own — use Run now on a card'
          }
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-deck-800"
        >
          <span
            className={`relative h-4 w-7 rounded-full transition-colors ${autoRun ? 'bg-grass-500' : 'bg-deck-600'}`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${autoRun ? 'left-3.5' : 'left-0.5'}`}
            />
          </span>
          <span className={autoRun ? 'text-deck-100' : ''}>Auto-run</span>
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {STREAM_COLUMNS.map((col) => {
          const colItems = sortColumn(items, col.value)
          const canDrop = dragging !== null && dropStatus(dragging.status, col.value) !== null
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: drop target for kanban dnd
            <div
              key={col.value}
              onDragOver={(e) => {
                if (!canDrop) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTarget(col.value)
                // cards stopPropagation on dragOver, so reaching here means empty space -> drop at end
                setDropLine({ col: col.value, before: null })
              }}
              onDragLeave={() => {
                setDropTarget((cur) => (cur === col.value ? null : cur))
                setDropLine((cur) => (cur?.col === col.value ? null : cur))
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop(colItems, col.value, null)
              }}
              className={`flex min-h-0 flex-col gap-2 rounded-lg p-2 transition-colors duration-150 ${
                dropTarget === col.value && canDrop
                  ? 'bg-grass-600/30 ring-1 ring-grass-500'
                  : canDrop
                    ? 'bg-grass-600/20'
                    : dragging
                      ? 'bg-grass-600/5'
                      : 'bg-grass-600/10'
              }`}
            >
              <h3
                title={col.hint}
                className="shrink-0 cursor-help px-1 text-xs font-semibold uppercase tracking-wide text-deck-300"
              >
                {col.label} <span className="font-normal text-deck-400">({colItems.length})</span>
              </h3>
              {/* p-px: WebKit clips 1px card borders sitting exactly on the scroll container's clip edge */}
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-px">
                {colItems.map((x) => (
                  // wrapper (line + card) is the drop target: hovering the line itself stays stable
                  // biome-ignore lint/a11y/noStaticElementInteractions: drop target for kanban dnd
                  <div
                    key={x.id}
                    className="flex flex-col gap-2"
                    onDragOver={(e) => {
                      if (!canDrop) return
                      e.preventDefault()
                      e.stopPropagation()
                      e.dataTransfer.dropEffect = 'move'
                      setDropTarget(col.value)
                      setDropLine((cur) =>
                        cur?.col === col.value && cur.before === x.id ? cur : { col: col.value, before: x.id },
                      )
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      drop(colItems, col.value, x)
                    }}
                  >
                    {dropLine?.col === col.value && dropLine.before === x.id && !noMove(colItems, x) && (
                      <div className="pointer-events-none h-0.5 rounded-full bg-grass-400" />
                    )}
                    <Card
                      item={x}
                      onOpen={() => setOpenId(x.id)}
                      onAction={(a) => onAction(x, a)}
                      onDragStart={() => setDragging(x)}
                      onDragEnd={endDrag}
                    />
                  </div>
                ))}
                {dropLine?.col === col.value && dropLine.before === null && !noMove(colItems, null) && (
                  <div className="h-0.5 shrink-0 rounded-full bg-grass-400" />
                )}
              </div>
            </div>
          )
        })}
      </div>
      {/* the dump sits under the board, like a chat box */}
      <div className="mx-[70px] my-[35px] shrink-0">
        <Dump repos={repos} slash={slash} onAdd={onAdd} />
      </div>
      {open && (
        <StreamPanel
          key={open.id}
          item={open}
          version={version}
          repos={names}
          onAction={onAction}
          onProject={(x, repo) => write(() => setStreamProject(x, repo, 'me'), 'set stream project')}
          onEdited={reload}
          onClose={() => setOpenId(null)}
        />
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
