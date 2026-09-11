import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useRef, useState } from 'react'
import { buildFeed, type FeedEvent, type TimelineSummary } from '../lib/feed'
import { approvePr } from '../lib/gh'
import { resumeInGhostty } from '../lib/ghostty'
import { openPrWindow } from '../lib/prwindow'
import type { Run, RunLine } from '../lib/runs'
import { sessionCwd } from '../lib/sessions'
import { canApproveFrom, STAGES } from '../lib/stages'
import { timeAgo } from '../lib/time'
import type { ActionButton, ReviewTask, Stage } from '../types'
import { ActionIcon } from './ActionIcon'
import { Markdown } from './Markdown'
import { PrLink } from './PrLink'
import { SidePanel } from './SidePanel'

type Props = {
  task: ReviewTask
  run: Run | undefined
  me: string
  myName?: string
  // 'review' = the Reviews board (adds a built-in approve button + stage select).
  // 'pr' = the Pull Requests board for my own PRs.
  variant?: 'review' | 'pr'
  buttons: ActionButton[] // user-configured action buttons, already filtered by their visibility conditions
  onReply: (text: string) => void
  onRunButton: (button: ActionButton) => void
  onStageChange: (stage: Stage) => void
  onSnooze: (snoozed: boolean) => void
  onKill: () => void
  onCancel: () => void
  onDismissRun: () => void
  onClose: () => void
  // fired on open with the card summary derived from the freshly-fetched timeline (per-card refresh)
  onRefresh?: (summary: TimelineSummary) => void
}

type ReplyBoxProps = {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onCancel: () => void
  canReply: boolean
  running: boolean
  placeholder: string
}

// Auto-growing reply field: Enter sends, Shift+Enter adds a line, cancel aborts a running turn
const ReplyBox = ({ value, onChange, onSend, onCancel, canReply, running, placeholder }: ReplyBoxProps) => {
  const ref = useRef<HTMLTextAreaElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every value change
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])
  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSend()
          }
        }}
        disabled={!canReply}
        placeholder={running ? 'claude is working… cancel to send something else' : placeholder}
        className="max-h-40 flex-1 resize-none overflow-y-auto rounded border border-deck-600 bg-deck-800 px-2 py-1.5 text-sm outline-none focus:border-grass-500 disabled:opacity-50"
      />
      {running ? (
        <button
          type="button"
          onClick={onCancel}
          title="Cancel this turn — the session stays resumable, then send a new message"
          className="cursor-pointer rounded-md border border-red-400/40 bg-red-500/20 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/40"
        >
          ■ cancel
        </button>
      ) : (
        <button
          type="button"
          onClick={onSend}
          disabled={!canReply}
          className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm hover:bg-grass-500 disabled:opacity-50"
        >
          Send
        </button>
      )}
    </div>
  )
}

const CheckIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m4 12.5 5.5 5.5L20 6.5" />
  </svg>
)

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

const MoonIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </svg>
)

const TerminalIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
  </svg>
)

const CopyIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
)

const ExternalIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
)

const StopIcon = () => (
  <svg {...iconProps} fill="currentColor" stroke="none" aria-hidden="true">
    <rect width="14" height="14" x="5" y="5" rx="2" />
  </svg>
)

const RemoveIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M8 12h8" />
  </svg>
)

// URLs in session output: click to open in the in-app browser window
// (capture group -> odd split indexes are URLs; last char must not be trailing punctuation)
const URL_SPLIT = /(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])/g

const Linkify = ({ text, onOpen }: { text: string; onOpen: (url: string, external: boolean) => void }) => (
  <>
    {text.split(URL_SPLIT).map((part, i) =>
      i % 2 === 1 ? (
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: static text snapshot
          key={i}
          href={part}
          title="Open in app browser (⌘+click for default browser)"
          onClick={(e) => {
            e.preventDefault()
            onOpen(part, e.metaKey)
          }}
          className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-grass-300"
        >
          {part}
        </a>
      ) : (
        part
      ),
    )}
  </>
)

// One row per command instead of a wrapped wall of pale gray: the detail is truncated to a single
// line, click reveals the whole thing (heredoc bodies, long gh invocations).
const ToolLine = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false)
  const cut = text.indexOf(' ')
  const name = cut === -1 ? text : text.slice(0, cut)
  const detail = cut === -1 ? '' : text.slice(cut + 1)
  return (
    <button
      type="button"
      onClick={() => setOpen((s) => !s)}
      title={open ? 'Collapse' : text}
      className="flex w-full cursor-crosshair items-baseline gap-1.5 text-left font-mono text-xs leading-5 text-deck-500 hover:text-deck-300"
    >
      <span className="shrink-0 text-deck-400">{name}</span>
      <span className={open ? 'min-w-0 flex-1 whitespace-pre-wrap break-all' : 'min-w-0 flex-1 truncate'}>
        {detail}
      </span>
    </button>
  )
}

// Our own prompt: action-button prompts are long, so clamp them until clicked.
const UserLine = ({ text, onOpen }: { text: string; onOpen: (url: string, external: boolean) => void }) => {
  const [open, setOpen] = useState(false)
  const long = text.length > 180 || text.includes('\n')
  const body = (
    <span className={open ? 'whitespace-pre-wrap' : 'line-clamp-2'}>
      ❯ <Linkify text={text} onOpen={onOpen} />
    </span>
  )
  return long ? (
    <button
      type="button"
      onClick={() => setOpen((s) => !s)}
      title={open ? 'Collapse' : 'Show the full prompt'}
      className="cursor-pointer text-left font-medium text-grass-300"
    >
      {body}
    </button>
  ) : (
    <p className="font-medium text-grass-300">{body}</p>
  )
}

// Consecutive lines of the same kind render as one block: text groups become a single markdown
// document (so a table split across stream chunks still parses), tool groups a tight command list.
const groupLines = (lines: RunLine[]): RunLine[][] =>
  lines.reduce<RunLine[][]>((groups, l) => {
    const last = groups.at(-1)
    if (last && last[0].kind === l.kind) last.push(l)
    else groups.push([l])
    return groups
  }, [])

export const SessionPanel = ({
  task,
  run,
  me,
  myName = '',
  variant = 'review',
  buttons,
  onReply,
  onRunButton,
  onStageChange,
  onSnooze,
  onKill,
  onCancel,
  onDismissRun,
  onClose,
  onRefresh,
}: Props) => {
  const isPr = variant === 'pr'
  const [input, setInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedBranch, setCopiedBranch] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approved, setApproved] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [feed, setFeed] = useState<FeedEvent[] | null>(null)
  const [report, setReport] = useState<{ path: string; content: string } | null>(null)
  const [showRun, setShowRun] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const reportRef = useRef<{ path: string; content: string } | null>(null)
  reportRef.current = report

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild feed when switching task
  useEffect(() => {
    setFeed(null)
    setReport(null)
    buildFeed(task, me, myName).then((r) => {
      setFeed(r.feed)
      onRefresh?.(r.summary) // patch this card from the timeline we just fetched
    })
  }, [task.id])

  // chronological feed: keep the newest events in view, next to the reply input
  useEffect(() => {
    if (feed) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [feed])

  // refresh history when a run finishes or a new report gets linked (no manual ↻ needed)
  const runIdle = run?.status === 'awaiting-input' || run?.status === 'closed'
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh triggers only
  useEffect(() => {
    if (runIdle) buildFeed(task, me, myName).then((r) => setFeed(r.feed))
  }, [runIdle, task.reviewFiles.length])

  const openReport = async (path: string) => {
    try {
      setReport({ path, content: await readTextFile(path) })
    } catch {
      setReport({ path, content: '(could not read report file)' })
    }
  }

  const send = () => {
    if (!input.trim()) return
    onReply(input.trim())
    setInput('')
  }

  // Esc first closes the report overlay if it's open; otherwise the shell closes the panel
  const onEscape = useCallback(() => {
    if (!reportRef.current) return false
    setReport(null)
    return true
  }, [])

  const running = run?.status === 'running'
  const sessionId = run?.sessionId ?? task.sessionIds.at(-1)
  // generic chat: as soon as the card has a session, the input talks to the latest one
  // (live run -> reply into it; none -> resume the last session)
  const showReply = (!!run && run.status !== 'closed') || (!!sessionId && !!task.repoPath)
  const canReply = !running && !!sessionId && (!!run || !!task.repoPath)

  // Resuming only works from the directory the session ran in, which for a PR branch is usually a
  // worktree, not the clone. A live run already knows its own cwd; otherwise go find it.
  const checkoutFor = async (id: string) =>
    run?.sessionId === id ? run.repoPath : await sessionCwd(task.repoPath ?? '', id)

  const copySessionId = async () => {
    if (!sessionId || !task.repoPath) return
    await writeText(`cd ${await checkoutFor(sessionId)} && claude --resume ${sessionId}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const copyBranch = async () => {
    await writeText(task.branch)
    setCopiedBranch(true)
    setTimeout(() => setCopiedBranch(false), 1500)
  }

  // one-click approval: once I've had my say (reviewed / follow-up / done), or a follow-up came back
  // all green (nothing pending/partial) from an earlier stage
  const allGreen = !!task.followupSummary && task.followupSummary.pending === 0 && task.followupSummary.partial === 0
  const alreadyApproved = feed?.some((e) => e.mine && e.text === 'review: approved') ?? true // hidden until feed loads
  const canApprove = (allGreen || canApproveFrom(task.stage)) && !alreadyApproved

  const approve = async () => {
    setApproving(true)
    try {
      await approvePr(task.repo, task.prNumber)
      setApproved(true)
      onStageChange('done') // approved = my part is over; merging is the author's business
    } finally {
      setApproving(false)
    }
  }

  // Ghostty deep link; falls back to copying the resume command when Ghostty is missing
  const resumeSession = async (id: string) => {
    if (!task.repoPath) return
    const launched = await resumeInGhostty(await checkoutFor(id), id)
    if (!launched) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <SidePanel onClose={onClose} onEscape={onEscape}>
      {({ close }) => (
        <>
          <div className="border-b border-deck-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <PrLink
                url={task.prUrl}
                repo={task.repo}
                prNumber={task.prNumber}
                className="shrink-0 text-xs text-deck-400 hover:text-grass-300"
              >
                {task.repo}#{task.prNumber} ↗
              </PrLink>
              <div className="ml-auto flex items-center gap-1.5">
                {!isPr && (
                  <select
                    value={task.stage}
                    onChange={(e) => onStageChange(e.target.value as Stage)}
                    className="h-7 cursor-pointer rounded border border-deck-600 bg-deck-800 px-1.5 text-xs text-deck-200 outline-none"
                  >
                    {STAGES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                )}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMoreOpen((s) => !s)}
                    title="More options"
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-deck-600 text-sm text-deck-300 hover:bg-deck-700"
                  >
                    ⋯
                  </button>
                  {moreOpen && (
                    <div className="absolute right-0 top-full z-40 mt-1 flex w-60 flex-col rounded-md border border-deck-700 bg-deck-800 py-1 shadow-xl">
                      <button
                        type="button"
                        onClick={() => {
                          onSnooze(!task.snoozed)
                          setMoreOpen(false)
                        }}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-deck-200 hover:bg-deck-700"
                      >
                        <MoonIcon /> {task.snoozed ? 'Unhide' : 'Hide until new activity'}
                      </button>
                      {sessionId && (
                        <button
                          type="button"
                          onClick={() => {
                            resumeSession(sessionId)
                            setMoreOpen(false)
                          }}
                          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-deck-200 hover:bg-deck-700"
                        >
                          <TerminalIcon /> Resume session in Ghostty
                        </button>
                      )}
                      {sessionId && (
                        <button
                          type="button"
                          onClick={copySessionId}
                          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-deck-200 hover:bg-deck-700"
                        >
                          <CopyIcon /> {copied ? 'Copied!' : 'Copy resume command'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          openUrl(task.prUrl)
                          setMoreOpen(false)
                        }}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-deck-200 hover:bg-deck-700"
                      >
                        <ExternalIcon /> Open in browser
                      </button>
                      {!isPr && (
                        <button
                          type="button"
                          onClick={() => {
                            onStageChange('discovered')
                            setMoreOpen(false)
                            close()
                          }}
                          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-deck-200 hover:bg-deck-700"
                        >
                          <RemoveIcon /> Remove from board
                        </button>
                      )}
                      {running && (
                        <button
                          type="button"
                          onClick={() => {
                            onKill()
                            setMoreOpen(false)
                          }}
                          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-600/20"
                        >
                          <StopIcon /> Kill run
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={close}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-xl leading-none text-deck-400 hover:text-deck-100"
                >
                  ✕
                </button>
              </div>
            </div>
            <h2 className="mt-1.5 text-lg font-semibold leading-snug text-white">{task.prTitle}</h2>
            <div className="mt-2 flex items-center gap-1.5 text-xs">
              <code className="truncate rounded border border-deck-700 bg-deck-800 px-1.5 py-0.5 font-mono text-deck-300">
                {task.branch}
              </code>
              <button
                type="button"
                onClick={copyBranch}
                title="Copy branch name"
                className="cursor-pointer text-deck-500 hover:text-grass-300"
              >
                {copiedBranch ? 'copied!' : '⧉'}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-b border-deck-800 px-4 py-2">
            {buttons.map((b, i) => (
              <button
                key={b.id}
                type="button"
                onClick={() => onRunButton(b)}
                disabled={running}
                title={b.prompt}
                className={
                  i === 0
                    ? 'cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm hover:bg-grass-500 disabled:opacity-50'
                    : 'cursor-pointer rounded-md border border-grass-600 px-3 py-1.5 text-sm text-grass-300 hover:bg-grass-600/20 disabled:opacity-50'
                }
              >
                <span className="flex items-center gap-1.5">
                  <ActionIcon name={b.icon} /> {b.label}
                </span>
              </button>
            ))}
            {!isPr && (canApprove || approved) && (
              <button
                type="button"
                onClick={approve}
                disabled={approving || approved}
                title="Approve the PR on GitHub and move it to Done"
                className="ml-auto cursor-pointer rounded-md bg-grass-500 px-3 py-1.5 text-sm font-medium text-deck-950 hover:bg-grass-400 disabled:opacity-60"
              >
                <span className="flex items-center gap-1.5">
                  <CheckIcon /> {approved ? 'approved' : approving ? 'approving…' : 'approve'}
                </span>
              </button>
            )}
            {run?.status === 'awaiting-input' && (
              <span className="self-center text-xs text-grass-300">awaiting input</span>
            )}
          </div>

          {running && (
            <div className="flex items-center gap-2.5 border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-sm text-amber-200">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
              </span>
              claude is working — {run?.command} in progress…
              <button
                type="button"
                onClick={onKill}
                title="Stop this run (the session stays resumable)"
                className="ml-auto cursor-pointer rounded border border-red-400/40 bg-red-500/20 px-2 py-0.5 text-xs text-red-200 hover:bg-red-500/40"
              >
                ■ stop
              </button>
            </div>
          )}

          {/* terminal stays pinned above the chat: only history events scroll */}
          {run && run.lines.length > 0 && (
            <div className="shrink-0 border-b border-deck-800 p-4 pb-3">
              <div className="rounded-lg border border-deck-700 bg-deck-800/50">
                <div className="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-deck-400">
                  <button
                    type="button"
                    onClick={() => setShowRun((s) => !s)}
                    className="flex flex-1 cursor-pointer items-center justify-between"
                  >
                    <span>
                      claude session output
                      {run.command && <span className="ml-1.5 normal-case text-grass-400">· {run.command}</span>}
                    </span>
                    <span>{showRun ? '▾' : '▸'}</span>
                  </button>
                  {!running && (
                    <button
                      type="button"
                      onClick={onDismissRun}
                      title="Dismiss this session output"
                      className="cursor-pointer normal-case text-deck-500 hover:text-deck-200"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {showRun && (
                  <div className="flex max-h-72 flex-col gap-2 overflow-y-auto px-3 pb-3 text-sm">
                    {groupLines(run.lines).map((group, gi) => {
                      const openLink = (url: string, external: boolean) =>
                        openPrWindow(url, task.repo, task.prNumber, external)
                      const kind = group[0].kind
                      const key = gi // append-only log: groups only ever grow or get appended to
                      if (kind === 'tool')
                        return (
                          <div key={key} className="flex flex-col rounded bg-deck-900/60 px-2 py-1">
                            {group.map((l, i) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
                              <ToolLine key={i} text={l.text} />
                            ))}
                          </div>
                        )
                      if (kind === 'text')
                        return (
                          <Markdown
                            key={key}
                            className="md-console"
                            text={group.map((l) => l.text).join('\n\n')}
                            onLink={openLink}
                          />
                        )
                      if (kind === 'user')
                        return (
                          <div key={key} className="flex flex-col gap-1">
                            {group.map((l, i) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
                              <UserLine key={i} text={l.text} onOpen={openLink} />
                            ))}
                          </div>
                        )
                      return (
                        <div key={key} className="flex flex-col gap-1">
                          {group.map((l, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
                            <p key={i} className="font-mono text-xs text-red-400">
                              <Linkify text={l.text} onOpen={openLink} />
                            </p>
                          ))}
                        </div>
                      )
                    })}
                    {running && <p className="animate-pulse text-xs text-deck-500">▍</p>}
                  </div>
                )}
              </div>
            </div>
          )}

          <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto bg-deck-950 px-4 pb-4">
            {/* mt-auto anchors the chat to the bottom until it overflows, like a real chat */}
            <div className="mt-auto">
              <h4 className="sticky top-0 z-10 -mx-4 flex items-center justify-between bg-deck-950 px-4 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-deck-400">
                history
                <button
                  type="button"
                  onClick={() => buildFeed(task, me, myName).then((r) => setFeed(r.feed))}
                  className="cursor-pointer text-deck-500 hover:text-deck-200"
                  title="Refresh history"
                >
                  ↻
                </button>
              </h4>
              {!feed && <p className="text-sm text-deck-500">loading history…</p>}
              {feed?.length === 0 && <p className="text-sm text-deck-500">No events yet.</p>}
              <ul className="flex flex-col gap-2">
                {feed?.map((e, i) => {
                  const body = (
                    <>
                      <span className="mr-1.5">{e.icon}</span>
                      <span className="font-medium">{e.mine ? 'you' : e.actor}</span> {e.text}
                      {e.filePath && ' ↗'}
                      {e.sessionId && ' 👻'}
                    </>
                  )
                  const bubbleClass = `max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ${
                    e.mine
                      ? 'rounded-br-sm bg-grass-600/25 text-grass-100'
                      : 'rounded-bl-sm border border-deck-700 bg-deck-800 text-deck-200'
                  }`
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static snapshot list
                    <li key={i} className={`flex flex-col ${e.mine ? 'items-end' : 'items-start'}`}>
                      {e.filePath || e.url || e.sessionId ? (
                        <button
                          type="button"
                          title={e.sessionId ? `Resume session ${e.sessionId} in Ghostty` : undefined}
                          onClick={(ev) =>
                            e.filePath
                              ? openReport(e.filePath)
                              : e.sessionId
                                ? resumeSession(e.sessionId)
                                : openPrWindow(e.url as string, task.repo, task.prNumber, ev.metaKey)
                          }
                          className={`${bubbleClass} cursor-pointer text-left hover:underline`}
                        >
                          {body}
                        </button>
                      ) : (
                        <div className={bubbleClass}>{body}</div>
                      )}
                      <span
                        className={`mt-0.5 text-[10px] text-deck-500 ${e.mine ? 'pr-1' : 'pl-1'}`}
                        title={new Date(e.ts).toLocaleString()}
                      >
                        {/* ✓✓ = that claude session has concluded (not running anymore) */}
                        {e.sessionId && !(run?.sessionId === e.sessionId && run.status === 'running') && (
                          <span className="mr-1 text-grass-400" title="session completed">
                            ✓✓
                          </span>
                        )}
                        {timeAgo(e.ts)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>

          {showReply && (
            <div className="border-t border-deck-800 p-3">
              <ReplyBox
                value={input}
                onChange={setInput}
                onSend={send}
                onCancel={onCancel}
                canReply={canReply}
                running={running}
                placeholder="Message the latest claude session…"
              />
            </div>
          )}

          {report && (
            <div className="absolute inset-0 z-30 flex flex-col bg-deck-900">
              <div className="flex items-center gap-2 border-b border-deck-800 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => setReport(null)}
                  title="Back to the PR panel"
                  className="cursor-pointer rounded px-2 py-1 text-deck-300 hover:bg-deck-800 hover:text-deck-100"
                >
                  ← back
                </button>
                <p className="min-w-0 flex-1 truncate font-mono text-xs text-deck-400">
                  {report.path.split('/').at(-1)}
                </p>
              </div>
              <Markdown
                text={report.content}
                onLink={(url, external) => openPrWindow(url, task.repo, task.prNumber, external)}
                className="prose prose-sm prose-invert max-w-none flex-1 overflow-auto p-4 prose-headings:text-deck-100 prose-a:text-grass-300 prose-code:text-grass-300 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-deck-800 prose-td:text-deck-200 prose-th:text-deck-300"
              />
              {showReply && (
                <div className="border-t border-deck-800 p-3">
                  <ReplyBox
                    value={input}
                    onChange={setInput}
                    onSend={send}
                    onCancel={onCancel}
                    canReply={canReply}
                    running={running}
                    placeholder='send comments from here — e.g. "1,3" or "all"'
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </SidePanel>
  )
}
