import { useCallback, useEffect, useMemo, useState } from 'react'
import { CardMenuPopover, MENU_WIDTH } from '../components/CardMenu'
import { type Confirm, ConfirmDialog } from '../components/ConfirmDialog'
import { actorIcon, RefChip, StreamPanel } from '../components/StreamPanel'
import {
  addStreamItems,
  removeStreamItem,
  resetStreamPriority,
  setStreamOrders,
  setStreamStatus,
  streamItems,
} from '../lib/db'
import { logError } from '../lib/log'
import {
  applyStreamAction,
  columnOf,
  dropStatus,
  entryRank,
  isNoMove,
  movedIds,
  parseDump,
  STATUS_LABEL,
  STREAM_COLUMNS,
  type StreamActionId,
  sortColumn,
  streamActions,
} from '../lib/stream'
import { timeAgo } from '../lib/time'
import type { StreamColumn, StreamItem, StreamStatus, WatchedRepo } from '../types'

// The Stream board: things I dumped for Lookout's agents to work through (AI_TASKS/2026-09-29-stream-tab.md).
// Manual for now: dump, prioritise by drag, move by hand. Agents pick items up in the next phases.

type Props = { repos: WatchedRepo[] }

// statuses whose column already says it all get no tag
const QUIET: StreamStatus[] = ['idea', 'queued', 'done']

const TAG_CLASS: Partial<Record<StreamStatus, string>> = {
  paused: 'bg-deck-700 text-deck-300',
  skipped: 'bg-deck-700 text-deck-400',
  failed: 'bg-red-500/20 text-red-300',
  interrupted: 'bg-amber-500/20 text-amber-300',
  running: 'animate-pulse bg-amber-500/20 text-amber-300',
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
        item.status === 'paused' || item.status === 'skipped' ? 'opacity-60' : ''
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
        <span className="truncate text-deck-300">{item.repo.split('/')[1]}</span>
        <RefChip item={item} />
        {!QUIET.includes(item.status) && (
          <span className={`rounded px-1 py-0.5 ${TAG_CLASS[item.status] ?? 'bg-deck-700'}`}>
            {STATUS_LABEL[item.status]}
          </span>
        )}
        <span className="ml-auto shrink-0" title={`created by ${item.createdBy}, ${timeAgo(item.createdAt)}`}>
          {actorIcon(item.createdBy)} {timeAgo(item.createdAt)}
        </span>
      </div>
    </div>
  )
}

// The dump: type or paste what I want done, one line each; a list of targets splits into one item
// per target unless I say they go together. The preview shows what will be created.
const Dump = ({
  repos,
  onAdd,
}: {
  repos: WatchedRepo[]
  onAdd: (repo: string, text: string, queue: boolean) => void
}) => {
  const [text, setText] = useState('')
  const [repo, setRepo] = useState(repos[0]?.repo ?? '')
  // a repo removed from Settings while picked falls back to the first one
  const picked = repos.some((r) => r.repo === repo) ? repo : (repos[0]?.repo ?? '')
  const preview = useMemo(() => parseDump(text, picked), [text, picked])

  if (!repos.length)
    return <p className="text-sm text-deck-400">Add a project in Settings to start dumping work here.</p>

  const add = (queue: boolean) => {
    if (!preview.length) return
    onAdd(picked, text, queue)
    setText('')
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-deck-800 bg-deck-900 p-2">
      <div className="flex items-start gap-2">
        <select
          value={picked}
          onChange={(e) => setRepo(e.target.value)}
          aria-label="Project"
          className="shrink-0 cursor-pointer rounded-md border border-deck-700 bg-deck-800 px-2 py-1.5 text-sm text-deck-100 focus:border-deck-500 focus:outline-none"
        >
          {repos.map((r) => (
            <option key={r.repo} value={r.repo}>
              {r.repo}
            </option>
          ))}
        </select>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              add(e.shiftKey)
            }
          }}
          rows={text.includes('\n') ? 4 : 1}
          placeholder="Dump what needs doing — one per line. “implement card 1,2,3,4” makes 4 items; add “in one branch” to keep them together.  ⌘↵ Inbox · ⇧⌘↵ Queued"
          className="min-w-0 flex-1 resize-y rounded-md border border-deck-700 bg-deck-800/80 px-3 py-1.5 text-sm text-deck-100 placeholder:text-deck-500 focus:border-deck-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => add(false)}
          disabled={!preview.length}
          className="shrink-0 cursor-pointer rounded-md bg-deck-700 px-3 py-1.5 text-sm hover:bg-deck-600 disabled:cursor-default disabled:opacity-40"
        >
          To Inbox
        </button>
        <button
          type="button"
          onClick={() => add(true)}
          disabled={!preview.length}
          className="shrink-0 cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm hover:bg-grass-500 disabled:cursor-default disabled:opacity-40"
        >
          Queue
        </button>
      </div>
      {preview.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-1 text-xs text-deck-300">
          <li className="text-deck-500">
            {preview.length} item{preview.length > 1 ? 's' : ''}:
          </li>
          {preview.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no identity yet; two lines may read the same
            <li key={i} className="rounded bg-deck-800 px-1.5 py-0.5">
              {d.title}
              {d.ref && <span className="ml-1 text-deck-500">→ {d.ref}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export const Stream = ({ repos }: Props) => {
  const [items, setItems] = useState<StreamItem[]>([])
  const [version, setVersion] = useState(0) // bumped after every write: the open panel re-reads its feed
  const [openId, setOpenId] = useState<string | null>(null)
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

  useEffect(() => {
    reload()
  }, [reload])

  const write = async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn()
    } catch (e) {
      logError('stream', e, what)
    }
    await reload()
  }

  const onAdd = (repo: string, text: string, queue: boolean) =>
    write(() => addStreamItems(repo, parseDump(text, repo), queue ? 'queued' : 'idea'), 'add stream items')

  const onAction = (item: StreamItem, action: StreamActionId) => {
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
    <div className="flex h-full flex-col gap-3">
      <div className="shrink-0">
        <Dump repos={repos} onAdd={onAdd} />
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
      {open && (
        <StreamPanel
          key={open.id}
          item={open}
          version={version}
          onAction={onAction}
          onEdited={reload}
          onClose={() => setOpenId(null)}
        />
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
