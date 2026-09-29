import { useEffect, useState } from 'react'
import { CardFrame } from '../components/CardFrame'
import { openPrWindow } from '../lib/prwindow'
import { moveRepoBefore } from '../lib/repoorder'
import { timeAgo } from '../lib/time'
import type { ReviewTask, WatchedRepo } from '../types'

type Props = {
  tasks: ReviewTask[]
  repos: WatchedRepo[] // watched repos, in the configured order — drives the column order
  onReview: (id: string) => void
  onWatch: (id: string) => void
  onIgnore: (id: string) => void
  showIgnored: boolean
  onToggleIgnored: () => void
  onUnignore: (id: string) => void
  onSetSeen: (id: string, seen: boolean) => void
  onReorderRepos: (repoNames: string[]) => void
}

// per-card "⋯" menu: mark seen/unseen + ignore/unignore, the option shown depending on the card's state
const RowMenu = ({
  task,
  big,
  onIgnore,
  onUnignore,
  onSetSeen,
}: {
  task: ReviewTask
  big?: boolean
  onIgnore: (id: string) => void
  onUnignore: (id: string) => void
  onSetSeen: (id: string, seen: boolean) => void
}) => {
  const [open, setOpen] = useState(false)
  const item = 'cursor-pointer px-3 py-1.5 text-left text-xs text-deck-200 hover:bg-deck-700'
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        title="More options"
        className={`flex cursor-pointer items-center rounded border border-deck-600 text-deck-300 hover:bg-deck-700 ${
          big ? 'h-7 px-2.5 text-sm' : 'h-5 px-1.5'
        }`}
      >
        ⋯
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
            }}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div className="absolute right-0 top-full z-40 mt-1 flex w-44 flex-col rounded-md border border-deck-700 bg-deck-800 py-1 shadow-xl">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onSetSeen(task.id, !task.seen)
                setOpen(false)
              }}
              className={item}
            >
              {task.seen ? 'Mark as unseen' : 'Mark as seen'}
            </button>
            {task.stage === 'ignored' ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onUnignore(task.id)
                  setOpen(false)
                }}
                className={item}
              >
                Unignore
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onIgnore(task.id)
                  setOpen(false)
                }}
                className={item}
              >
                Ignore
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const DiscoveryCard = ({
  t,
  wide,
  onReview,
  onWatch,
  onIgnore,
  onUnignore,
  onSetSeen,
}: {
  t: ReviewTask
  wide?: boolean // focus mode: full-width card, bigger actions
  onReview: (id: string) => void
  onWatch: (id: string) => void
  onIgnore: (id: string) => void
  onUnignore: (id: string) => void
  onSetSeen: (id: string, seen: boolean) => void
}) => (
  <CardFrame
    title={t.prTitle}
    author={t.prAuthor}
    repo={t.repo}
    prNumber={t.prNumber}
    wide={wide}
    onClick={(e) => {
      onSetSeen(t.id, true)
      openPrWindow(t.prUrl, t.repo, t.prNumber, e.metaKey)
    }}
    className={`${t.isDraft ? 'card-draft' : ''} ${t.seen ? '' : 'ring-1 ring-grass-500/60'}`}
  >
    {!t.seen && <span className="h-2 w-2 rounded-full bg-grass-400" title="New — not seen yet" />}
    {t.isDraft && <span className="rounded bg-deck-700 px-1 py-0.5 text-deck-400">✎ Draft</span>}
    {t.reviewRequested && <span className="rounded bg-amber-500/20 px-1 py-0.5 text-amber-300">review requested</span>}
    <span className="rounded bg-grass-600/20 px-1 py-0.5 font-medium text-grass-300">{timeAgo(t.prCreatedAt)}</span>
    <div className="ml-auto flex items-center gap-1">
      <button
        type="button"
        title="Add to board + start /do-review now"
        onClick={(e) => {
          e.stopPropagation()
          onReview(t.id)
        }}
        className={`cursor-pointer rounded bg-grass-600 font-medium text-white hover:bg-grass-500 ${
          wide ? 'h-7 px-3 text-sm' : 'h-5 px-1.5'
        }`}
      >
        review
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onWatch(t.id)
        }}
        className={`cursor-pointer rounded border border-grass-600 text-grass-300 hover:bg-grass-600/20 ${
          wide ? 'h-7 px-3 text-sm' : 'h-5 px-1.5'
        }`}
      >
        watch
      </button>
      <RowMenu task={t} big={wide} onIgnore={onIgnore} onUnignore={onUnignore} onSetSeen={onSetSeen} />
    </div>
  </CardFrame>
)

export const Discovery = ({
  tasks,
  repos,
  onReview,
  onWatch,
  onIgnore,
  showIgnored,
  onToggleIgnored,
  onUnignore,
  onSetSeen,
  onReorderRepos,
}: Props) => {
  // the repo whose column is being dragged, and the column its insertion line sits before (null = last)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  // double-clicking a column title zooms into that project alone
  const [focus, setFocus] = useState<string | null>(null)

  const discovered = tasks
    .filter((t) => t.stage === 'discovered' && t.prState === 'open')
    .sort(
      (a, b) =>
        Number(b.reviewRequested) - Number(a.reviewRequested) ||
        Number(a.isDraft) - Number(b.isDraft) || // drafts sink to the bottom of the column
        (b.prCreatedAt ?? '').localeCompare(a.prCreatedAt ?? ''),
    )
  const ignored = tasks.filter((t) => t.stage === 'ignored' && t.prState === 'open')

  // configured order first, then any repo with PRs that isn't watched anymore (kept visible, alphabetical)
  const configured = repos.map((r) => r.repo).filter((r, i, all) => all.indexOf(r) === i)
  const extra = [...new Set(discovered.map((t) => t.repo))].filter((r) => !configured.includes(r)).sort()
  // every watched repo gets a column, so the ordering is always complete; empty ones opt out of the
  // configured order and sink to the end (sort is stable, so each group keeps its own order)
  const columns = [...configured, ...extra].sort(
    (a, b) => Number(!discovered.some((t) => t.repo === a)) - Number(!discovered.some((t) => t.repo === b)),
  )
  // focus mode: one project, everything else out of the way
  const shown = focus && columns.includes(focus) ? [focus] : columns
  const inScope = focus ? ignored.filter((t) => t.repo === focus) : ignored

  // Escape leaves focus mode (nothing else on this view listens for it)
  useEffect(() => {
    if (!focus) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocus(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus])

  // dropping a column onto itself, or onto the column right after it, wouldn't move anything
  const isNoMove = (before: string | null) => {
    if (!dragging) return true
    const idx = columns.indexOf(dragging)
    if (before === null) return idx === columns.length - 1
    const beforeIdx = columns.indexOf(before)
    return beforeIdx === idx || beforeIdx === idx + 1
  }

  const drop = (before: string | null) => {
    if (dragging && !isNoMove(before)) onReorderRepos(moveRepoBefore(columns, dragging, before))
    setDragging(null)
    setDropBefore(undefined)
  }

  const dragOver = (before: string | null) => (e: React.DragEvent) => {
    if (!dragging) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropBefore((cur) => (cur === before ? cur : before))
  }

  const DropLine = ({ before }: { before: string | null }) =>
    dropBefore === before && !isNoMove(before) ? (
      <div className="w-0.5 shrink-0 self-stretch rounded-full bg-grass-400" />
    ) : null

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          {focus ? (
            <>
              <button
                type="button"
                onClick={() => setFocus(null)}
                title="Back to all projects (Esc)"
                className="cursor-pointer rounded border border-deck-600 px-1.5 text-sm text-deck-300 hover:bg-deck-700"
              >
                ←
              </button>
              <h2 className="text-lg font-semibold">
                <span className="text-deck-400">{focus.split('/')[0]}/</span>
                {focus.split('/')[1]}
              </h2>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">Discovery</h2>
              {/* hover hint: keeps the drag affordance discoverable without a permanent line of text */}
              <span className="group relative flex items-center">
                <span className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-deck-600 text-[10px] text-deck-400 group-hover:border-deck-400 group-hover:text-deck-200">
                  ?
                </span>
                <span className="pointer-events-none absolute left-6 top-0 hidden whitespace-nowrap rounded border border-deck-700 bg-deck-800 px-2 py-1 text-xs text-deck-300 shadow-xl group-hover:block">
                  drag a column title to reorder your projects, double-click one to focus it
                </span>
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggleIgnored}
            className="cursor-pointer text-xs text-deck-400 hover:text-deck-200"
          >
            {showIgnored ? 'hide ignored' : `show ignored (${inScope.length})`}
          </button>
        </div>
      </div>

      {discovered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <span className="text-6xl">🎉</span>
          <p className="font-script text-3xl text-grass-300">All caught up!</p>
          <p className="text-sm text-deck-400">No new pull requests waiting for you. Go grab a coffee ☕</p>
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: drop target for the column dnd
        <div
          className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-px"
          onDragOver={dragOver(null)}
          onDrop={(e) => {
            e.preventDefault()
            drop(null)
          }}
        >
          {shown.map((repo) => {
            const items = discovered.filter((t) => t.repo === repo)
            // an empty column collapses to a faded spine: vertical title only, no card area
            // (never in focus mode — there the one column stays full width)
            const collapsed = !focus && items.length === 0
            const focused = focus === repo // the one column left: it takes the whole width
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: drop target for the column dnd
              <div
                key={repo}
                className={`flex min-h-0 gap-3 ${focused ? 'min-w-0 flex-1' : ''}`}
                onDragOver={dragOver(repo)}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  drop(repo)
                }}
              >
                <DropLine before={repo} />
                <div
                  className={`flex min-h-0 flex-col gap-2 rounded-lg transition-colors duration-150 ${
                    focused
                      ? 'min-w-0 flex-1'
                      : collapsed
                        ? 'w-8 shrink-0 p-1 opacity-50 hover:opacity-100'
                        : 'w-72 shrink-0 p-2'
                  } ${focused ? '' : dragging === repo ? 'bg-grass-600/30 ring-1 ring-grass-500' : 'bg-grass-600/10'}`}
                >
                  {/* the header is the drag handle: cards keep their own click/menu affordances.
                      Focus mode drops it: the view header already names the project. */}
                  {!focused && (
                    // biome-ignore lint/a11y/noStaticElementInteractions: column drag handle
                    <div
                      draggable
                      onDoubleClick={() => setFocus(repo)}
                      onDragStart={(e) => {
                        // WebKit requires setData for the drag to actually start
                        e.dataTransfer.setData('text/plain', repo)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(repo)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setDropBefore(undefined)
                      }}
                      title={
                        collapsed
                          ? `${repo} — nothing new (drag to reorder, double-click to focus)`
                          : 'Drag to reorder projects, double-click to focus'
                      }
                      className={`flex cursor-grab gap-2 text-sm active:cursor-grabbing ${
                        collapsed ? 'min-h-0 flex-1 justify-center py-1' : 'mb-1 shrink-0 items-center px-1 pb-1'
                      }`}
                    >
                      {/* GitHub-style repo label: muted owner, bold repo, count in a pill */}
                      <span className={`min-w-0 truncate ${collapsed ? '[writing-mode:vertical-rl]' : ''}`}>
                        <span className="text-deck-400">{repo.split('/')[0]}/</span>
                        <span className="font-semibold text-deck-100">{repo.split('/')[1]}</span>
                      </span>
                      {/* the count would always read 0 on a collapsed column */}
                      {!collapsed && (
                        <span className="shrink-0 rounded-full bg-deck-700 px-1.5 py-0.5 text-xs text-deck-300">
                          {items.length}
                        </span>
                      )}
                    </div>
                  )}
                  {/* p-px: WebKit clips 1px card borders sitting exactly on the scroll container's
                      (fractional-width) clip edge — give them 1px of breathing room */}
                  {!collapsed && (
                    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-px">
                      {items.length === 0 && (
                        <p className="rounded-lg border border-dashed border-deck-700 p-3 text-center text-xs text-deck-500">
                          Nothing new
                        </p>
                      )}
                      {items.map((t) => (
                        <DiscoveryCard
                          key={t.id}
                          t={t}
                          wide={focused}
                          onReview={onReview}
                          onWatch={onWatch}
                          onIgnore={onIgnore}
                          onUnignore={onUnignore}
                          onSetSeen={onSetSeen}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          <DropLine before={null} />

          {showIgnored && inScope.length > 0 && (
            <div className="flex min-h-0 w-72 shrink-0 flex-col gap-2 rounded-lg bg-deck-800/40 p-2">
              <h3 className="mb-1 flex shrink-0 items-center gap-2 px-1 pb-1 text-sm font-semibold text-deck-400">
                Ignored
                <span className="rounded-full bg-deck-800 px-1.5 py-0.5 text-xs font-normal text-deck-500">
                  {inScope.length}
                </span>
              </h3>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-px">
                {inScope.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 rounded border border-deck-800 p-2 text-xs text-deck-500"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {t.repo.split('/')[1]}#{t.prNumber} — {t.prTitle}
                    </span>
                    <RowMenu task={t} onIgnore={onIgnore} onUnignore={onUnignore} onSetSeen={onSetSeen} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
