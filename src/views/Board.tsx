import { useState } from 'react'
import { BoardFilters } from '../components/BoardFilters'
import { CardFrame, type CardMenu } from '../components/CardFrame'
import { CiFailBadge, CiNeutralBadge, ConflictsBadge } from '../components/CiFailBadge'
import { Icon } from '../components/Icon'
import { StreamChip } from '../components/StreamChip'
import { Tip } from '../components/Tip'
import { type BoardFilter, emptyFilter, matchesFilter, openAuthorOptions, openRepoOptions } from '../lib/filters'
import type { Run } from '../lib/runs'
import { STAGE_LABEL } from '../lib/stages'
import type { ReviewTask, Stage, StreamItem } from '../types'

type Props = {
  tasks: ReviewTask[]
  runs: Run[]
  alertedIds: Set<string> // cards with an unread notification (same set the bell shows)
  onOpenSession: (t: ReviewTask, checks?: boolean) => void // checks: unfold the failing CI checks
  onSeen: (t: ReviewTask) => void
  onReorder: (t: ReviewTask, stage: Stage, orderedIds: string[]) => void
  menuFor: (t: ReviewTask) => CardMenu // quick actions: hover ⋯ and right-click
  streamByRef: Map<string, StreamItem> // the live Stream card working on each PR (🌊 chip)
}

// hint doubles as the column's tooltip: what a card in it actually means
const COLUMNS: { stage: Stage[]; title: string; hint: string }[] = [
  { stage: ['watching'], title: STAGE_LABEL.watching, hint: 'On the board, nothing done yet.' },
  {
    stage: ['needs_review', 'reviewing'],
    title: STAGE_LABEL.needs_review,
    hint: 'A review session ran, but nothing was sent to the PR yet.',
  },
  { stage: ['reviewed'], title: STAGE_LABEL.reviewed, hint: 'I sent at least one comment on the PR.' },
  { stage: ['followup'], title: STAGE_LABEL.followup, hint: 'A follow-up run happened.' },
  { stage: ['done'], title: STAGE_LABEL.done, hint: 'I approved the PR, or it merged.' },
]

const DONE_TTL_MS = 24 * 60 * 60 * 1000

type CardProps = {
  t: ReviewTask
  run: Run | undefined
  alerted: boolean
  onOpen: (checks?: boolean) => void
  onSeen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  menu: CardMenu
  stream: StreamItem | undefined
}

const Card = ({ t, run, alerted, onOpen, onSeen, onDragStart, onDragEnd, menu, stream }: CardProps) => (
  <CardFrame
    menu={menu}
    title={t.prTitle}
    author={t.prAuthor}
    repo={t.repo}
    prNumber={t.prNumber}
    onClick={() => onOpen()}
    draggable
    onDragStart={(e) => {
      // WebKit requires setData for the drag to actually start
      e.dataTransfer.setData('text/plain', t.id)
      e.dataTransfer.effectAllowed = 'move'
      onDragStart()
    }}
    onDragEnd={onDragEnd}
    className={`${t.isDraft ? 'card-draft' : ''} ${t.snoozed ? 'opacity-50' : ''} ${
      run?.status === 'running' ? 'card-running' : alerted ? 'card-awaiting' : ''
    }`}
  >
    {(t.prState !== 'open' || t.stage === 'done') && (
      <span
        className={`rounded px-1 py-0.5 ${t.prState === 'merged' ? 'bg-purple-500/20 text-purple-300' : t.prState === 'open' ? 'bg-grass-500/20 text-grass-300' : 'bg-red-500/20 text-red-300'}`}
      >
        {t.prState === 'open' && t.approved ? '✓ approved' : t.prState}
      </span>
    )}
    <StreamChip item={stream} />
    {/* a red build stays visible in Done too, while the PR is still open */}
    {t.stage === 'done' && t.prState === 'open' && t.ciState === 'fail' && (
      <CiFailBadge checks={t.ciChecks} onOpen={() => onOpen(true)} />
    )}
    {t.stage !== 'done' && (
      <>
        {run?.status === 'running' && (
          <span className="animate-pulse rounded bg-amber-500/20 px-1 py-0.5 text-amber-300">running</span>
        )}
        {t.followupSummary && (
          <span className="rounded bg-deck-700 px-1 py-0.5">
            <Icon name="stop" size={12} /> {t.followupSummary.pending} <Icon name="alert" size={12} />{' '}
            {t.followupSummary.partial} <Icon name="check-circle" size={12} /> {t.followupSummary.addressed}
          </span>
        )}
        {t.hasNewActivity && (
          <Tip label="New comments/reviews since last look — click to dismiss">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onSeen()
              }}
              className="cursor-pointer rounded bg-amber-500/20 px-1 py-0.5 text-amber-300 hover:bg-amber-500/40"
            >
              <Icon name="comment" size={12} /> new
            </button>
          </Tip>
        )}
        {/* merged/closed: the build no longer matters */}
        {t.prState === 'open' && (
          <>
            {t.ciState === 'pass' && <span className="rounded bg-grass-500/20 px-1 py-0.5 text-grass-300">✓ CI</span>}
            {t.ciState === 'fail' && <CiFailBadge checks={t.ciChecks} onOpen={() => onOpen(true)} />}
            {t.ciState === 'pending' && <span className="rounded bg-deck-700 px-1 py-0.5 text-deck-400">CI …</span>}
            {t.ciState === 'neutral' && <CiNeutralBadge />}
            {t.ciState === null && t.conflicts && <ConflictsBadge />}
          </>
        )}
      </>
    )}
  </CardFrame>
)

export const Board = ({ tasks, runs, alertedIds, onOpenSession, onSeen, onReorder, menuFor, streamByRef }: Props) => {
  const [showSnoozed, setShowSnoozed] = useState(false)
  const [filter, setFilter] = useState<BoardFilter>(emptyFilter)
  const [dragging, setDragging] = useState<ReviewTask | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  // insertion indicator: line above card `before`, or at the column end when before is null
  const [dropLine, setDropLine] = useState<{ col: number; before: string | null } | null>(null)
  const now = Date.now()
  const active = tasks.filter(
    (t) => !(t.stage === 'done' && t.doneAt && now - new Date(t.doneAt).getTime() > DONE_TTL_MS),
  )
  const openRows = active.map((t) => ({ repo: t.repo, author: t.prAuthor, open: t.prState === 'open' }))
  const repoOptions = openRepoOptions(openRows)
  const authorOptions = openAuthorOptions(openRows)
  // snoozed cards stay hidden until new activity; Done column always shows
  const visible = active.filter(
    (t) => (showSnoozed || !t.snoozed || t.stage === 'done') && matchesFilter(filter, t.repo, t.ciState, t.prAuthor),
  )
  const snoozedCount = active.filter((t) => t.snoozed && t.stage !== 'done').length
  const runByTask = new Map(runs.map((r) => [r.taskId, r]))

  // hide the insertion line when dropping there wouldn't move the card
  // (over itself, over the card right after it, or at the end while already last)
  const isNoMove = (colItems: ReviewTask[], before: ReviewTask | null) => {
    if (!dragging) return true
    const idx = colItems.findIndex((x) => x.id === dragging.id)
    if (idx < 0) return false // coming from another column: always a real move
    if (before === null) return idx === colItems.length - 1
    const beforeIdx = colItems.findIndex((x) => x.id === before.id)
    return beforeIdx === idx || beforeIdx === idx + 1
  }

  // drop the dragged card into a column, before `before` (or at the end)
  const drop = (colItems: ReviewTask[], stage: Stage, before: ReviewTask | null) => {
    if (!dragging) return
    const rest = colItems.filter((x) => x.id !== dragging.id)
    const idx = before ? rest.findIndex((x) => x.id === before.id) : rest.length
    const at = idx < 0 ? rest.length : idx
    const ordered = [...rest.slice(0, at), dragging, ...rest.slice(at)]
    onReorder(
      dragging,
      stage,
      ordered.map((x) => x.id),
    )
    setDragging(null)
    setDropTarget(null)
    setDropLine(null)
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <BoardFilters repos={repoOptions} authors={authorOptions} filter={filter} onChange={setFilter} />
        {snoozedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowSnoozed((s) => !s)}
            className="ml-auto cursor-pointer text-xs text-deck-400 hover:text-deck-200"
          >
            {showSnoozed ? 'hide snoozed' : `show snoozed (${snoozedCount})`}
          </button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {COLUMNS.map((col, colIdx) => {
          const isDone = col.stage.includes('done')
          const items = visible
            .filter((t) => col.stage.includes(t.stage))
            // Done ignores drag order: open cards first, merged/closed last (updatedAt tiebreak)
            // Other columns: drag order first; unranked cards follow, drafts at the bottom
            .sort((a, b) =>
              isDone
                ? (a.prState === 'open' ? 0 : 1) - (b.prState === 'open' ? 0 : 1) ||
                  b.updatedAt.localeCompare(a.updatedAt)
                : (a.sortOrder ?? (a.isDraft ? 2e9 : 1e9)) - (b.sortOrder ?? (b.isDraft ? 2e9 : 1e9)) ||
                  b.updatedAt.localeCompare(a.updatedAt),
            )
          const canDrop = dragging !== null // any column: other = move stage, same = reorder
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: drop target for kanban dnd
            <div
              key={col.title}
              onDragOver={(e) => {
                if (!canDrop) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTarget(colIdx)
                // cards stopPropagation on dragOver, so reaching here means empty space -> drop at end
                setDropLine({ col: colIdx, before: null })
              }}
              onDragLeave={() => {
                setDropTarget((cur) => (cur === colIdx ? null : cur))
                setDropLine((cur) => (cur?.col === colIdx ? null : cur))
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop(items, col.stage[0], null)
              }}
              className={`flex min-h-0 flex-col gap-2 rounded-lg p-2 transition-colors duration-150 ${
                dropTarget === colIdx && canDrop
                  ? 'bg-grass-600/30 ring-1 ring-grass-500'
                  : dragging
                    ? 'bg-grass-600/20'
                    : 'bg-grass-600/10'
              }`}
            >
              <Tip label={col.hint}>
                <h3 className="w-fit shrink-0 cursor-help px-1 text-xs font-semibold uppercase tracking-wide text-deck-300">
                  {col.title} <span className="font-normal text-deck-400">({items.length})</span>
                </h3>
              </Tip>
              {/* p-px: WebKit clips 1px card borders sitting exactly on the scroll container's
                  (fractional-width) clip edge — give them 1px of breathing room */}
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-px">
                {items.map((t) => (
                  // wrapper (line + card) is the drop target: hovering the line itself stays stable
                  // biome-ignore lint/a11y/noStaticElementInteractions: drop target for kanban dnd
                  <div
                    key={t.id}
                    className="flex flex-col gap-2"
                    onDragOver={(e) => {
                      if (!dragging) return
                      e.preventDefault()
                      e.stopPropagation()
                      e.dataTransfer.dropEffect = 'move'
                      setDropTarget(colIdx)
                      setDropLine((cur) =>
                        cur?.col === colIdx && cur.before === t.id ? cur : { col: colIdx, before: t.id },
                      )
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      drop(items, col.stage[0], t)
                    }}
                  >
                    {dropLine?.col === colIdx && dropLine.before === t.id && !isNoMove(items, t) && (
                      <div className="pointer-events-none h-0.5 rounded-full bg-grass-400" />
                    )}
                    <Card
                      t={t}
                      run={runByTask.get(t.id)}
                      alerted={alertedIds.has(t.id)}
                      onOpen={(checks) => onOpenSession(t, checks)}
                      onSeen={() => onSeen(t)}
                      menu={menuFor(t)}
                      stream={streamByRef.get(t.id)}
                      onDragStart={() => setDragging(t)}
                      onDragEnd={() => {
                        setDragging(null)
                        setDropTarget(null)
                        setDropLine(null)
                      }}
                    />
                  </div>
                ))}
                {dropLine?.col === colIdx && dropLine.before === null && !isNoMove(items, null) && (
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
