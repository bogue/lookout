import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useRef, useState } from 'react'
import { avatarUrl } from '../lib/avatar'
import { cardActions } from '../lib/cardactions'
import { buildFeed, type FeedEvent, mergeReports, reportEvents, type TimelineSummary } from '../lib/feed'
import { approvePr, fetchMergeOptions, mergePr } from '../lib/gh'
import { resumeInGhostty } from '../lib/ghostty'
import { MERGE_METHODS, type MergeOptions, pickMethod } from '../lib/merge'
import { openPrWindow } from '../lib/prwindow'
import type { Run, RunLine } from '../lib/runs'
import { sessionCwd } from '../lib/sessions'
import { canApproveFrom, STAGES } from '../lib/stages'
import { messageTime } from '../lib/time'
import type { ActionButton, MergeMethod, MergePreference, ReviewTask, Stage } from '../types'
import { ActionIcon } from './ActionIcon'
import { BackButton } from './BackButton'
import { CardMenuList } from './CardMenu'
import { CloseButton } from './CloseButton'
import { type Confirm, ConfirmDialog } from './ConfirmDialog'
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
  mergeMethod: MergePreference // the Merge button's preselected strategy (Settings)
  buttons: ActionButton[] // user-configured action buttons, already filtered by their visibility conditions
  onReply: (text: string) => void
  onRunButton: (button: ActionButton) => void
  onStageChange: (stage: Stage) => void
  onSnooze: (snoozed: boolean) => void
  onKill: () => void
  onCancel: () => void
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
      className="cursor-pointer text-left font-mono text-grass-300"
    >
      {body}
    </button>
  ) : (
    <p className="font-mono text-grass-300">{body}</p>
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

const feedName = (e: FeedEvent) => (e.actor === 'Lookout' ? 'Lookout' : e.mine ? 'You' : e.actor || 'Lookout')

// Lucide "reply": marks a report as the answer to the session stacked behind it
const ReplyIcon = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="9 17 4 12 9 7" />
    <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
  </svg>
)

// Who a history message is from: the GitHub picture, or an emoji for what has no account. A login
// that doesn't resolve (a commit carries a git author name, not a login) falls back to its initial.
// A badge (my picture, on Lookout's 👀: it acts for me) sits small over the bottom-right corner.
const FeedAvatar = ({ avatar, name }: { avatar: FeedEvent['avatar']; name: string }) => {
  const [broken, setBroken] = useState(false)
  // one visible 28px circle for every kind, so an emoji reads the same size as a photo
  const cls = 'flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-deck-700 ring-1 ring-deck-600'
  const face =
    'emoji' in avatar ? (
      <span className={`${cls} text-lg leading-none`} role="img" aria-label={name}>
        {avatar.emoji}
      </span>
    ) : broken ? (
      <span className={`${cls} text-sm font-medium text-deck-300`}>{name.charAt(0).toUpperCase()}</span>
    ) : (
      <img
        src={avatar.url ?? avatarUrl(avatar.login)}
        alt={name}
        onError={() => setBroken(true)}
        className={`${cls} object-cover`}
      />
    )
  // mt: clear the name line (leading-4 + mb-0.5) so the avatar sits beside the bubble, not the name
  return (
    <span className="relative mt-[20px] shrink-0">
      {face}
      {'badge' in avatar && avatar.badge && (
        <img
          src={avatarUrl(avatar.badge)}
          alt=""
          aria-hidden
          className="absolute -right-1 -bottom-1.5 h-4 w-4 rounded-full object-cover ring-1 ring-deck-950"
        />
      )}
    </span>
  )
}

// placeholder bubbles in the shape of the chat, bottom-anchored like the real one so nothing jumps on load
const SKELETON = [
  { mine: false, w: '55%' },
  { mine: false, w: '35%' },
  { mine: true, w: '45%' },
  { mine: false, w: '50%' },
]

const FeedSkeleton = () => (
  <ul aria-label="Loading history" className="flex animate-pulse flex-col gap-4">
    {SKELETON.map((b, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder
      <li key={i} className={`flex items-end gap-2 ${b.mine ? 'flex-row-reverse' : ''}`}>
        <span className="h-7 w-7 shrink-0 rounded-full bg-deck-800" />
        <span style={{ width: b.w }} className="h-9 rounded-[18px] bg-deck-800" />
      </li>
    ))}
  </ul>
)

export const SessionPanel = ({
  task,
  run,
  me,
  myName = '',
  variant = 'review',
  mergeMethod,
  buttons,
  onReply,
  onRunButton,
  onStageChange,
  onSnooze,
  onKill,
  onCancel,
  onClose,
  onRefresh,
}: Props) => {
  const isPr = variant === 'pr'
  const [input, setInput] = useState('')
  const [copiedBranch, setCopiedBranch] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approved, setApproved] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [mergeOpts, setMergeOpts] = useState<MergeOptions | null>(null)
  const [method, setMethod] = useState<MergeMethod | null>(null) // what the Merge button will do
  const [methodMenu, setMethodMenu] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [feed, setFeed] = useState<FeedEvent[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [report, setReport] = useState<{ title: string; content: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const runRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true) // terminal tails the output until you scroll away from the bottom
  const autoTopRef = useRef(-1)
  const reportRef = useRef<{ title: string; content: string } | null>(null)
  reportRef.current = report
  const confirmOpenRef = useRef(false)
  confirmOpenRef.current = !!confirm
  const methodMenuRef = useRef(false)
  methodMenuRef.current = methodMenu
  const mergeBoxRef = useRef<HTMLDivElement>(null)
  const taskRef = useRef(task)
  taskRef.current = task
  const feedSeq = useRef(0) // the latest full build; an older one landing after it is dropped

  // A full build fetches the timeline, so it can land after a report was linked meanwhile: its reports
  // are re-read once it's back, from the card as it is by then, and a superseded build is thrown away.
  const loadFeed = async () => {
    const seq = ++feedSeq.current
    const r = await buildFeed(task, me, myName)
    const feed = mergeReports(r.feed, await reportEvents(taskRef.current, me))
    if (seq !== feedSeq.current) return
    setFeed(feed)
    onRefresh?.(r.summary) // patch this card from the timeline we just fetched
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild feed when switching task
  useEffect(() => {
    setFeed(null)
    setReport(null)
    scrollRef.current?.scrollTo({ top: 0 }) // column-reverse: top 0 is the bottom, newest events
    loadFeed()
  }, [task.id])

  // Reports are Lookout's own, so the open card shows one as soon as it's stored: a finished run and
  // every sync hand in a fresh card, and its reports are merged in without refetching the timeline.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh card object is the trigger
  useEffect(() => {
    let live = true
    reportEvents(task, me).then((reports) => {
      if (live) setFeed((f) => f && mergeReports(f, reports))
    })
    return () => {
      live = false
    }
  }, [task])

  // which strategies this repo allows, for the Merge button (an open PR only)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when switching task
  useEffect(() => {
    setMergeOpts(null)
    setMergeError(null)
    setMethodMenu(false)
    if (task.prState !== 'open') return
    fetchMergeOptions(task.repo)
      .then((o) => {
        setMergeOpts(o)
        setMethod(pickMethod(o, mergeMethod))
      })
      .catch(() => setMergeOpts(null)) // logged by gh.ts; no button rather than a broken one
  }, [task.id, task.prState])

  // the strategy menu closes on any click outside the Merge button and its menu
  useEffect(() => {
    if (!methodMenu) return
    const outside = (e: MouseEvent) => {
      if (!mergeBoxRef.current?.contains(e.target as Node)) setMethodMenu(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [methodMenu])

  // a fresh run (or another card) starts tailing again
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm triggers only
  useEffect(() => {
    followRef.current = true
  }, [run, task.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the growing log
  useEffect(() => {
    const el = runRef.current
    if (!el || !followRef.current) return
    el.scrollTop = el.scrollHeight
    autoTopRef.current = el.scrollTop
  }, [run?.lines.length])

  // scrolling up stops the tail, snapping back to the bottom starts it again
  const onRunScroll = () => {
    const el = runRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 16) followRef.current = true
    // ignore the echo of our own scroll: lines appended since then grew scrollHeight, not scrollTop
    else if (el.scrollTop !== autoTopRef.current) followRef.current = false
  }

  // refresh history when a run finishes (no manual ↻ needed); its report comes in with the card above
  const runIdle = run?.status === 'awaiting-input' || run?.status === 'closed'
  const reloadFeed = () => {
    setRefreshing(true)
    loadFeed().finally(() => setRefreshing(false))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh trigger only
  useEffect(() => {
    if (runIdle) reloadFeed()
  }, [runIdle])

  const openReport = async (path: string) => {
    const title = path.split('/').at(-1) ?? path
    try {
      setReport({ title, content: await readTextFile(path) })
    } catch {
      setReport({ title, content: '(could not read report file)' })
    }
  }

  // a captured review has no file behind it: the markdown itself travelled on the feed event, and
  // the event's own wording is the title — a follow-up must not open under a review's name
  const openCaptured = (content: string, title: string) => setReport({ title, content })

  const send = () => {
    if (!input.trim()) return
    onReply(input.trim())
    setInput('')
  }

  // Esc first closes the report overlay if it's open; otherwise the shell closes the panel
  const onEscape = useCallback(() => {
    if (confirmOpenRef.current) return true // the dialog closes itself on Esc; keep the panel open
    if (methodMenuRef.current) {
      setMethodMenu(false)
      return true
    }
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

  const merge = async (m: MergeMethod) => {
    setMerging(true)
    setMergeError(null)
    try {
      await mergePr(task.repo, task.prNumber, m)
      if (!isPr) onStageChange('done')
      reloadFeed() // the merged event patches the card's state through onRefresh
    } catch (e) {
      setMergeError(e instanceof Error ? e.message.replace(/^.*failed: /s, '') : String(e))
    } finally {
      setMerging(false)
    }
  }

  // a red build doesn't block the merge (GitHub decides whether checks are required), it only warns
  const askMerge = () => {
    if (!method) return
    const label = MERGE_METHODS.find((x) => x.value === method)?.label ?? method
    const red = task.ciState === 'fail'
    const checks = task.ciChecks ? ` (${task.ciChecks.failed}/${task.ciChecks.total} checks failed)` : ''
    setConfirm({
      title: `Merge ${task.repo.split('/')[1]}#${task.prNumber}?`,
      body: `${label}.${red ? ` ⚠️ CI is red${checks} — merge anyway?` : ''}`,
      confirmLabel: red ? 'Merge anyway' : 'Merge',
      onConfirm: () => merge(method),
    })
  }

  const mergeBlocked = task.conflicts
    ? 'Merge conflicts — fix the branch first'
    : task.isDraft
      ? 'Draft — mark it ready for review first'
      : null
  // only once a reviewer approved; `approved` covers an approval I just gave from this panel, before
  // the next sync records it
  const showMerge = task.prState === 'open' && (task.approved || approved) && !!method && !!mergeOpts

  // Ghostty deep link; falls back to copying the resume command when Ghostty is missing
  const resumeSession = async (id: string) => {
    if (!task.repoPath) return
    await resumeInGhostty(await checkoutFor(id), id)
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
                      <CardMenuList
                        actions={cardActions({ snoozed: task.snoozed, hasSession: !!sessionId, isPr, running })}
                        onSelect={(id) => {
                          setMoreOpen(false)
                          if (id === 'snooze') {
                            onSnooze(!task.snoozed)
                            // snoozing hides the card, so leave the panel; unsnoozing keeps it open
                            if (!task.snoozed) close()
                          } else if (id === 'resume' && sessionId) resumeSession(sessionId)
                          else if (id === 'open-browser') openUrl(task.prUrl)
                          else if (id === 'remove') {
                            onStageChange('discovered')
                            close()
                          } else if (id === 'kill') onKill()
                        }}
                      />
                    </div>
                  )}
                </div>
                <CloseButton onClick={close} />
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
            <div className="ml-auto flex gap-2">
              {!isPr && (canApprove || approved) && (
                <button
                  type="button"
                  onClick={approve}
                  disabled={approving || approved}
                  title="Approve the PR on GitHub and move it to Done"
                  className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm hover:bg-grass-500 disabled:opacity-60"
                >
                  <span className="flex items-center gap-1.5">
                    <CheckIcon /> {approved ? 'Approved' : approving ? 'Approving…' : 'Approve'}
                  </span>
                </button>
              )}
              {showMerge && mergeOpts && method && (
                <div ref={mergeBoxRef} className="relative flex">
                  <button
                    type="button"
                    onClick={askMerge}
                    disabled={merging || !!mergeBlocked}
                    title={mergeBlocked ?? `${MERGE_METHODS.find((x) => x.value === method)?.label} on GitHub`}
                    className={`cursor-pointer bg-grass-600 px-3 py-1.5 text-sm hover:bg-grass-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                      mergeOpts.allowed.length > 1 ? 'rounded-l-md' : 'rounded-md'
                    }`}
                  >
                    {merging
                      ? 'Merging…'
                      : method === 'merge'
                        ? 'Merge PR'
                        : method === 'squash'
                          ? 'Squash & merge'
                          : 'Rebase & merge'}
                  </button>
                  {mergeOpts.allowed.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setMethodMenu((s) => !s)}
                      disabled={merging || !!mergeBlocked}
                      title="Pick another merge strategy"
                      className="cursor-pointer rounded-r-md border-l border-black/20 bg-grass-600 px-[9px] py-1.5 text-sm hover:bg-grass-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      ▾
                    </button>
                  )}
                  {methodMenu && (
                    <div className="absolute right-0 top-full z-40 mt-1 flex w-56 flex-col rounded-md border border-deck-700 bg-deck-800 py-1 shadow-xl">
                      {MERGE_METHODS.filter((m) => mergeOpts.allowed.includes(m.value)).map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => {
                            setMethod(m.value)
                            setMethodMenu(false)
                          }}
                          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-deck-200 hover:bg-deck-700"
                        >
                          <span className="w-3 text-grass-400">{m.value === method ? '✓' : ''}</span>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {mergeError && <p className="w-full text-xs text-red-300">could not merge: {mergeError}</p>}
          </div>

          {/* terminal sits above the chat, capped so history always keeps room; each scrolls on its own */}
          {run && (running || run.lines.length > 0) && (
            <div className="flex max-h-[45vh] shrink-0 flex-col border-b border-deck-800 p-4 pb-3">
              {/* terminal window: title bar ($ claude · status · command), darker console body below */}
              <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-deck-700 bg-deck-900">
                <div className="relative flex w-full items-center gap-2 border-b border-deck-700 px-4 py-2.5 font-mono text-sm">
                  <span className="text-grass-400">$</span>
                  <span className="text-deck-200">claude</span>
                  {running && (
                    <>
                      <span className="relative flex h-2.5 w-2.5 shrink-0">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
                      </span>
                      <span className="text-amber-200">is working…</span>
                    </>
                  )}
                  {run.command && <span className="ml-auto truncate text-xs text-deck-500">{run.command}</span>}
                  {running && (
                    <button
                      type="button"
                      onClick={onKill}
                      title="Stop this run (the session stays resumable)"
                      className={`shrink-0 cursor-pointer rounded border border-red-400/40 bg-red-500/20 px-2 py-0.5 font-sans text-xs text-red-200 hover:bg-red-500/40 ${run.command ? '' : 'ml-auto'}`}
                    >
                      ■ stop
                    </button>
                  )}
                  {/* progress runs along the header's bottom border, under the $ claude line */}
                  {running && (
                    <div className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden" aria-hidden>
                      <div className="terminal-progress h-full bg-amber-400" />
                    </div>
                  )}
                </div>
                <div
                  ref={runRef}
                  onScroll={onRunScroll}
                  className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-deck-950 px-4 py-3 text-sm"
                >
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
                  {running && <span className="h-4 w-2 shrink-0 animate-pulse bg-grass-400/80" aria-hidden />}
                </div>
              </div>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col bg-deck-950">
            <h4 className="flex shrink-0 items-center justify-between px-4 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-deck-400">
              history
              <button
                type="button"
                onClick={reloadFeed}
                disabled={refreshing}
                className="cursor-pointer text-deck-500 hover:text-deck-200 disabled:cursor-default"
                title="Refresh history"
              >
                <span className={`inline-block ${refreshing ? 'animate-spin' : ''}`}>↻</span>
              </button>
            </h4>
            {/* column-reverse anchors the chat to the bottom natively: short history sits next to the
                reply box, and the view stays pinned to the newest event while the terminal above resizes */}
            <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto px-4 pb-4">
              {!feed ? (
                <FeedSkeleton />
              ) : feed.length === 0 ? (
                <p className="m-auto text-sm text-deck-500">No events yet.</p>
              ) : (
                <ul className="flex flex-col">
                  {feed.map((e, i) => {
                    // a report reads as a title ("📄 Review done (See Report)")
                    const isReport = Boolean(e.filePath || e.body)
                    const name = feedName(e)
                    // a run of messages from one person shows who once, on its first message
                    const prev = feed[i - 1]
                    const grouped = prev !== undefined && prev.mine === e.mine && feedName(prev) === name
                    // ✓✓ = that claude session has concluded (not running anymore)
                    const done = e.sessionId && !(run?.sessionId === e.sessionId && run.status === 'running')
                    const meta = (
                      <>
                        {messageTime(e.ts)}
                        {done && <span className="ml-1 text-grass-400">✓✓</span>}
                      </>
                    )
                    // messenger-style stamp: an invisible copy at the end of the text reserves the room, so
                    // the real one, pinned bottom-right and dipping into the bottom padding, shares the last
                    // line when it fits and wraps when not
                    const body = (
                      <>
                        <span className="mr-1.5">{e.icon}</span>
                        <span className={e.filePath || e.body || e.url || e.sessionId ? 'group-hover:underline' : ''}>
                          {e.text}
                          {isReport && ' (See Report) ↗'}
                          {e.sessionId && ' 👻'}
                        </span>
                        <span aria-hidden className="invisible ml-2 text-[10px]">
                          {meta}
                        </span>
                        <span
                          className="absolute right-2.5 bottom-1 text-[10px] text-deck-500"
                          title={`${new Date(e.ts).toLocaleString()}${done ? ' · session completed' : ''}`}
                        >
                          {meta}
                        </span>
                      </>
                    )
                    // 18px = half a one-line bubble (8 + 20 + 8 px tall, leading-5 so an emoji can't grow the
                    // line): one line reads as a pill, centred, more lines as a softly squared box
                    const bubbleClass = `relative rounded-[18px] border px-3 py-2 text-sm leading-5 ${
                      e.mine
                        ? 'border-grass-700/60 bg-grass-600/25 text-grass-100'
                        : 'border-deck-700 bg-deck-800 text-deck-200'
                    }`
                    const bubble =
                      e.filePath || e.body || e.url || e.sessionId ? (
                        <button
                          type="button"
                          title={e.sessionId ? `Resume session ${e.sessionId} in Ghostty` : undefined}
                          onClick={(ev) =>
                            e.body
                              ? openCaptured(e.body, e.text)
                              : e.filePath
                                ? openReport(e.filePath)
                                : e.sessionId
                                  ? resumeSession(e.sessionId)
                                  : openPrWindow(e.url as string, task.repo, task.prNumber, ev.metaKey)
                          }
                          className={`${bubbleClass} group cursor-pointer text-left`}
                        >
                          {body}
                        </button>
                      ) : (
                        <div className={bubbleClass}>{body}</div>
                      )
                    return (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: static snapshot list
                        key={i}
                        className={`flex items-start gap-2 ${e.mine ? 'flex-row-reverse' : ''} ${i === 0 ? '' : grouped ? 'mt-1' : 'mt-4'}`}
                      >
                        {grouped ? <span className="w-7 shrink-0" /> : <FeedAvatar avatar={e.avatar} name={name} />}
                        <div className={`flex max-w-[60%] min-w-0 flex-col ${e.mine ? 'items-end' : 'items-start'}`}>
                          {/* a reply always says what it answers, even inside a run from one person */}
                          {(!grouped || e.replyTo) && (
                            <span className="mb-0.5 flex items-center gap-1 text-[12px] leading-4 font-bold text-deck-400">
                              {e.replyTo && <ReplyIcon />}
                              {e.replyTo ? `Reply from ${name}` : name}
                            </span>
                          )}
                          {e.replyTo ? (
                            // the session this report answers sits behind it, like a card under a card:
                            // 20px further left, same right edge, peeking out on top, squarer, content grayed
                            <div className="grid">
                              <div
                                className="rounded-xl border border-grass-700/40 bg-grass-700/15 px-3 pt-2 pb-5 text-xs text-deck-300"
                                title={
                                  e.replyTo.exact
                                    ? 'The session this report was captured from'
                                    : 'The last session started before this report (the file names none)'
                                }
                              >
                                {/* the bubble stays solid; only what it says is toned down */}
                                <span className="[filter:grayscale(70%)]">
                                  🤖 {e.replyTo.text} · {messageTime(e.replyTo.ts)}
                                </span>
                              </div>
                              {/* opaque underlay: the front bubble's tint is translucent and would show the back one */}
                              <div className="-mt-3 ml-[20px] rounded-[18px] bg-deck-950">{bubble}</div>
                            </div>
                          ) : (
                            bubble
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
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
                <BackButton onClick={() => setReport(null)} title="Back to the PR panel" />
                <p className="min-w-0 flex-1 truncate font-mono text-xs text-deck-400">{report.title}</p>
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
          {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
        </>
      )}
    </SidePanel>
  )
}
