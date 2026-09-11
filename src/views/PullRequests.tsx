import { useState } from 'react'
import { BoardFilters } from '../components/BoardFilters'
import { CardFrame } from '../components/CardFrame'
import { type BoardFilter, emptyFilter, matchesFilter, openRepoOptions } from '../lib/filters'
import { PR_COLUMNS } from '../lib/prboard'
import type { Run } from '../lib/runs'
import type { CiState, MyPr, PrColumn, ReviewFlavor } from '../types'

type Props = {
  prs: MyPr[]
  me: string
  runs: Run[]
  alertedIds: Set<string> // PRs with an unread notification (same set the bell shows)
  onOpen: (pr: MyPr) => void
  onHandleReview: (pr: MyPr) => void
  onReorder: (pr: MyPr, column: PrColumn, orderedIds: string[]) => void
}

// the board shows the pipeline columns; Done is appended on demand
const COLUMNS = PR_COLUMNS.filter((c) => c.value !== 'done')

const FLAVOR_LABEL: Record<Exclude<ReviewFlavor, null>, string> = {
  approved: 'approved',
  changes_requested: 'changes',
  commented: 'commented',
}

const flavorClass = (f: Exclude<ReviewFlavor, null>): string =>
  f === 'approved'
    ? 'bg-grass-500/20 text-grass-300'
    : f === 'changes_requested'
      ? 'bg-amber-500/20 text-amber-300'
      : 'bg-sky-500/20 text-sky-300'

// human review is what I'm waiting for → labelled plainly; bot review is an assist → prefixed 🤖
const ReviewTag = ({ flavor, bot }: { flavor: ReviewFlavor; bot?: boolean }) =>
  flavor ? (
    <span className={`rounded px-1 py-0.5 ${bot ? 'bg-deck-700 text-deck-300' : flavorClass(flavor)}`}>
      {bot ? '🤖 ' : ''}
      {FLAVOR_LABEL[flavor]}
    </span>
  ) : null

const CiTag = ({ ci }: { ci: CiState }) => {
  if (ci === 'pass') return <span className="rounded bg-grass-500/20 px-1 py-0.5 text-grass-300">CI ✓</span>
  if (ci === 'fail') return <span className="rounded bg-red-500/20 px-1 py-0.5 text-red-300">CI ✗</span>
  if (ci === 'pending') return <span className="rounded bg-deck-700 px-1 py-0.5 text-deck-400">CI …</span>
  return null
}

const PrCard = ({
  pr,
  me,
  run,
  alerted,
  onOpen,
  onHandleReview,
  onDragStart,
  onDragEnd,
}: {
  pr: MyPr
  me: string
  run: Run | undefined
  alerted: boolean
  onOpen: (pr: MyPr) => void
  onHandleReview: (pr: MyPr) => void
  onDragStart: () => void
  onDragEnd: () => void
}) => (
  <CardFrame
    title={pr.title}
    author={me}
    repo={pr.repo}
    prNumber={pr.number}
    onClick={() => onOpen(pr)}
    draggable
    onDragStart={(e) => {
      // WebKit requires setData for the drag to actually start
      e.dataTransfer.setData('text/plain', pr.id)
      e.dataTransfer.effectAllowed = 'move'
      onDragStart()
    }}
    onDragEnd={onDragEnd}
    className={`${pr.isDraft ? 'card-draft' : ''} ${
      run?.status === 'running' ? 'card-running' : alerted ? 'card-awaiting' : ''
    }`}
  >
    {pr.column === 'done' ? (
      // Done = dealt with: the review/CI detail no longer matters, just show the outcome
      pr.state === 'closed' ? (
        <span className="rounded bg-deck-700 px-1 py-0.5 text-deck-400">closed</span>
      ) : (
        <span className="rounded bg-purple-500/20 px-1 py-0.5 text-purple-300">merged</span>
      )
    ) : (
      <>
        {run?.status === 'running' && (
          <span className="animate-pulse rounded bg-amber-500/20 px-1 py-0.5 text-amber-300">running</span>
        )}
        {alerted && <span className="rounded bg-amber-500/20 px-1 py-0.5 text-amber-300">💬 new</span>}
        {pr.isDraft && <span className="rounded bg-deck-700 px-1 py-0.5 text-deck-400">✎ draft</span>}
        <ReviewTag flavor={pr.humanReview} />
        <ReviewTag flavor={pr.botReview} bot />
        <CiTag ci={pr.ciState} />
      </>
    )}
    {/* Gated on having a review to handle, not on the column: a bot review no longer moves the card
        out of Waiting, and clearing Cursor's comments is exactly the sort of thing this button runs. */}
    {pr.column !== 'done' && (pr.humanReview !== null || pr.botReview !== null) && (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onHandleReview(pr)
        }}
        title="Run /handle-review on this PR"
        className="ml-auto cursor-pointer rounded bg-grass-600 px-1.5 py-0.5 font-medium text-grass-50 hover:bg-grass-500"
      >
        handle review
      </button>
    )}
  </CardFrame>
)

// default (unranked) position: manual drag order first, then non-drafts, drafts at the bottom
const orderKey = (p: MyPr) => p.sortOrder ?? (p.isDraft ? 2e9 : 1e9)

export const PullRequests = ({ prs, me, runs, alertedIds, onOpen, onHandleReview, onReorder }: Props) => {
  const [showDone, setShowDone] = useState(false)
  const [filter, setFilter] = useState<BoardFilter>(emptyFilter)
  const [dragging, setDragging] = useState<MyPr | null>(null)
  const [dropTarget, setDropTarget] = useState<PrColumn | null>(null)
  // insertion indicator: line above card `before`, or at the column end when before is null
  const [dropLine, setDropLine] = useState<{ col: PrColumn; before: string | null } | null>(null)
  const repoOptions = openRepoOptions(prs.map((p) => ({ repo: p.repo, open: p.state === 'open' })))
  const runByPr = new Map(runs.map((r) => [r.taskId, r]))
  const byColumn = (c: PrColumn) =>
    prs
      .filter((p) => p.column === c && matchesFilter(filter, p.repo, p.ciState))
      // Done ignores drag order: it holds today's merges and closes, most recently dealt with first
      .sort((a, b) =>
        c === 'done'
          ? (b.doneAt ?? b.createdAt).localeCompare(a.doneAt ?? a.createdAt)
          : orderKey(a) - orderKey(b) || b.createdAt.localeCompare(a.createdAt),
      )
  const doneCount = prs.filter((p) => p.column === 'done' && matchesFilter(filter, p.repo, p.ciState)).length
  const columns = showDone ? PR_COLUMNS : COLUMNS

  // hide the insertion line when dropping there wouldn't move the card
  // (over itself, over the card right after it, or at the end while already last)
  const isNoMove = (colItems: MyPr[], before: MyPr | null) => {
    if (!dragging) return true
    const idx = colItems.findIndex((x) => x.id === dragging.id)
    if (idx < 0) return false // coming from another column: always a real move
    if (before === null) return idx === colItems.length - 1
    const beforeIdx = colItems.findIndex((x) => x.id === before.id)
    return beforeIdx === idx || beforeIdx === idx + 1
  }

  // drop the dragged card into a column, before `before` (or at the end)
  const drop = (colItems: MyPr[], column: PrColumn, before: MyPr | null) => {
    if (!dragging) return
    const rest = colItems.filter((x) => x.id !== dragging.id)
    const idx = before ? rest.findIndex((x) => x.id === before.id) : rest.length
    const at = idx < 0 ? rest.length : idx
    const ordered = [...rest.slice(0, at), dragging, ...rest.slice(at)]
    onReorder(
      dragging,
      column,
      ordered.map((x) => x.id),
    )
    setDragging(null)
    setDropTarget(null)
    setDropLine(null)
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <BoardFilters repos={repoOptions} filter={filter} onChange={setFilter} />
        {doneCount > 0 && (
          <button
            type="button"
            onClick={() => setShowDone((s) => !s)}
            className="ml-auto cursor-pointer text-xs text-deck-400 hover:text-deck-200"
          >
            {showDone ? 'hide done' : `show done (${doneCount})`}
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        {columns.map((col) => {
          const items = byColumn(col.value)
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: kanban drop target
            <div
              key={col.value}
              onDragOver={(e) => {
                if (!dragging) return
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
                drop(items, col.value, null)
              }}
              className={`flex min-h-0 flex-1 flex-col gap-2 rounded-lg p-2 transition-colors duration-150 ${
                dropTarget === col.value && dragging
                  ? 'bg-grass-600/30 ring-1 ring-grass-500'
                  : dragging
                    ? 'bg-grass-600/20'
                    : 'bg-grass-600/10'
              }`}
            >
              <h3 className="shrink-0 px-1 text-xs font-semibold uppercase tracking-wide text-deck-300">
                {col.label} <span className="font-normal text-deck-400">({items.length})</span>
              </h3>
              {/* p-px: WebKit clips 1px card borders sitting exactly on the scroll container's
                  (fractional-width) clip edge — give them 1px of breathing room */}
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-px">
                {items.map((pr) => (
                  // wrapper (line + card) is the drop target: hovering the line itself stays stable
                  // biome-ignore lint/a11y/noStaticElementInteractions: drop target for kanban dnd
                  <div
                    key={pr.id}
                    className="flex flex-col gap-2"
                    onDragOver={(e) => {
                      if (!dragging) return
                      e.preventDefault()
                      e.stopPropagation()
                      e.dataTransfer.dropEffect = 'move'
                      setDropTarget(col.value)
                      setDropLine((cur) =>
                        cur?.col === col.value && cur.before === pr.id ? cur : { col: col.value, before: pr.id },
                      )
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      drop(items, col.value, pr)
                    }}
                  >
                    {dropLine?.col === col.value && dropLine.before === pr.id && !isNoMove(items, pr) && (
                      <div className="pointer-events-none h-0.5 rounded-full bg-grass-400" />
                    )}
                    <PrCard
                      pr={pr}
                      me={me}
                      run={runByPr.get(pr.id)}
                      alerted={alertedIds.has(pr.id)}
                      onOpen={onOpen}
                      onHandleReview={onHandleReview}
                      onDragStart={() => setDragging(pr)}
                      onDragEnd={() => {
                        setDragging(null)
                        setDropTarget(null)
                        setDropLine(null)
                      }}
                    />
                  </div>
                ))}
                {dropLine?.col === col.value && dropLine.before === null && !isNoMove(items, null) && (
                  <div className="h-0.5 shrink-0 rounded-full bg-grass-400" />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
