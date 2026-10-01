import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { editStreamItem, streamEvents } from '../lib/db'
import { resumeInGhostty } from '../lib/ghostty'
import { logError } from '../lib/log'
import { getRuns, subscribeRuns } from '../lib/runs'
import { projectGateTarget, prRefOf, STATUS_LABEL, type StreamActionId, streamActions } from '../lib/stream'
import { nextStepOf } from '../lib/streamnext'
import {
  acceptProposal,
  cancelStreamItem,
  replyStreamItem,
  SHAPE_BRANCH,
  streamTaskId,
  watchStream,
} from '../lib/streamrunner'
import { proposalOf } from '../lib/streamshape'
import { TRIGGERS, waitingLabel } from '../lib/streamwatch'
import { messageTime } from '../lib/time'
import type { StreamEvent, StreamItem } from '../types'
import { CardMenuPopover, MENU_WIDTH } from './CardMenu'
import { CloseButton } from './CloseButton'
import { Markdown } from './Markdown'
import { PrLink } from './PrLink'
import { SidePanel } from './SidePanel'

// how long after a result the panel says Haiku is still thinking (it answers in seconds; past this it failed)
const SUGGEST_WAIT_MS = 60_000

type Props = {
  item: StreamItem
  version: number // bumped by the board after every write, so the feed re-reads
  repos: string[] // watched owner/repo, for the project picker
  onAction: (item: StreamItem, action: StreamActionId) => void
  onProject: (item: StreamItem, repo: string) => void
  onEdited: () => void
  onClose: () => void
}

// who did it, at a glance: the tracking trail of an item
export const actorIcon = (actor: string) =>
  actor === 'me'
    ? '👤'
    : actor === 'lookout'
      ? '🤖'
      : actor === 'github'
        ? '🐙'
        : actor === 'cli'
          ? '⌨️'
          : actor.startsWith('watcher:')
            ? '👁'
            : '•'

const eventText = (e: StreamEvent) =>
  e.kind === 'created'
    ? `Created${e.text ? ` — ${e.text}` : ''}`
    : e.kind === 'status'
      ? `Status ${e.text ?? ''}`
      : e.kind === 'edited'
        ? 'Edited'
        : e.kind === 'started'
          ? `Agent started${e.text ? ` — ${e.text}` : ''}`
          : e.kind === 'failed'
            ? `Failed — ${e.text ?? ''}`
            : e.kind === 'interrupted'
              ? `Interrupted — ${e.text ?? ''}`
              : `${e.kind}${e.text ? ` — ${e.text}` : ''}`

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'link'
  }
}

export const RefChip = ({ item }: { item: StreamItem }) => {
  if (!item.ref || !item.refKind) return null
  const pr = item.refKind === 'pr' ? prRefOf(item.ref) : null
  if (pr)
    return (
      <PrLink
        url={pr.url}
        repo={pr.repo}
        prNumber={pr.number}
        className="rounded bg-deck-700 px-1 py-0.5 text-deck-200"
      >
        {pr.repo === item.repo ? '' : pr.repo.split('/')[1]}#{pr.number}
      </PrLink>
    )
  return (
    <button
      type="button"
      title={item.ref}
      onClick={(e) => {
        e.stopPropagation()
        openUrl(item.ref ?? '')
      }}
      className="cursor-pointer rounded bg-deck-700 px-1 py-0.5 text-deck-200 hover:underline"
    >
      🔗 {hostOf(item.ref)}
    </button>
  )
}

// An item's side panel, a dispatch thread: its trail, the agent's live output, the result I
// review, and a composer to answer into the same session.
export const StreamPanel = ({ item, version, repos, onAction, onProject, onEdited, onClose }: Props) => {
  const [title, setTitle] = useState(item.title)
  // notes are hidden for now (no clear use in the thread yet); edits keep what is stored
  const body = item.body ?? ''
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [reply, setReply] = useState('')
  const runs = useSyncExternalStore(subscribeRuns, getRuns)
  const run = runs.find((r) => r.taskId === streamTaskId(item.id))
  const session = item.sessionIds.at(-1) ?? null
  const canReply = !!session && !!item.checkout && item.status !== 'running'
  const lastResultAt = events.map((e) => e.kind).lastIndexOf('result')
  const next = nextStepOf(events) // Haiku's suggested next step for the latest result
  // a shaping card (read-only agent on an idea): its proposal of cards, while still on the table
  const shaping = item.branch === SHAPE_BRANCH
  const proposal = shaping ? proposalOf(events) : null
  // taking the proposal: once (the buttons lock), its errors logged rather than lost
  const [taking, setTaking] = useState(false)
  const take = async (queue: boolean) => {
    if (!proposal || taking) return
    setTaking(true)
    try {
      await acceptProposal(item, proposal, queue)
    } catch (e) {
      logError('stream', e, 'accept proposal')
      setTaking(false)
    }
  }

  // header ⋯ holds the rare ones (skip, remove); the footer keeps the moves that drive the item
  // forward. Ordering (top/bottom/reset) belongs on the board, not in the thread.
  const MENU_IDS: StreamActionId[] = ['skip', 'remove']
  const HIDDEN_IDS: StreamActionId[] = ['approve', 'top', 'bottom', 'reset-priority'] // approve: on the result card
  const actions = streamActions(item)
  const menuActions = actions.filter((a) => MENU_IDS.includes(a.id))
  const footerActions = actions.filter((a) => !MENU_IDS.includes(a.id) && !HIDDEN_IDS.includes(a.id))
  // a card about a PR can wait on it once the agent has stopped (and has a session to resume)
  const canWatch =
    item.refKind === 'pr' && !!session && ['needs_review', 'question', 'interrupted', 'failed'].includes(item.status)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])

  // trail lines show one line; a click opens the full text
  const [expanded, setExpanded] = useState(new Set<number>())
  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (!n.delete(id)) n.add(id)
      return n
    })

  // a chat: open at the latest message, and follow new ones (an agent's live output included)
  const threadRef = useRef<HTMLDivElement>(null)
  const lineCount = run?.lines.length ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: the counts are the scroll triggers
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length, lineCount, next])

  // a reply into the session: typed in the composer, or one of Haiku's suggested buttons
  const sendReply = async (text: string) => {
    try {
      await replyStreamItem(item, text)
      return true
    } catch (e) {
      logError('stream', e, 'reply to stream item')
      return false
    }
  }

  const send = async () => {
    const text = reply.trim()
    if (!text) return
    setReply('')
    if (!(await sendReply(text))) setReply(text) // keep what I typed
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the re-read signal
  useEffect(() => {
    // two quick writes re-read twice: only the latest answer may land, or an older feed wins
    let current = true
    streamEvents(item.id)
      .then((es) => current && setEvents(es))
      .catch((e) => logError('stream', e, 'load stream events'))
    return () => {
      current = false
    }
  }, [item.id, version])

  const dirty = title.trim() !== item.title || (body.trim() || null) !== item.body
  const save = async () => {
    if (!title.trim()) return
    try {
      await editStreamItem(item.id, { title: title.trim(), body: body.trim() || null })
    } catch (e) {
      logError('stream', e, 'edit stream item') // the fields stay dirty, so nothing typed is lost
      return
    }
    onEdited()
  }

  return (
    <SidePanel onClose={onClose}>
      {({ close }) => (
        <>
          <div className="flex shrink-0 items-start gap-2 border-b border-deck-800 p-4">
            <div className="min-w-0 flex-1">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Title"
                className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-base font-medium text-white hover:border-deck-700 focus:border-deck-500 focus:outline-none"
              />
              <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-xs text-deck-400">
                <select
                  value={item.repo}
                  onChange={(e) => e.target.value && onProject(item, e.target.value)}
                  disabled={item.status === 'running'}
                  aria-label="Project"
                  className="cursor-pointer rounded border border-transparent bg-transparent py-0.5 text-deck-300 hover:border-deck-700 focus:border-deck-500 focus:outline-none disabled:cursor-default"
                >
                  {!item.repo && <option value="">no project yet</option>}
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <RefChip item={item} />
                <span className="rounded bg-deck-700 px-1 py-0.5">{STATUS_LABEL[item.status]}</span>
                <span title={`created by ${item.createdBy}`}>{actorIcon(item.createdBy)}</span>
              </div>
            </div>
            {menuActions.length > 0 && (
              <button
                type="button"
                title="More actions"
                aria-label="More actions"
                // the popover closes on any outside mousedown; this one is the toggle, not "outside"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setMenuAt(menuAt ? null : { x: r.right - MENU_WIDTH, y: r.bottom + 4 })
                }}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded border border-deck-600 text-sm text-deck-300 hover:bg-deck-800 hover:text-deck-100"
              >
                ⋯
              </button>
            )}
            {menuAt && (
              <CardMenuPopover
                at={menuAt}
                onClose={closeMenu}
                actions={menuActions}
                onSelect={(id) => onAction(item, id)}
              />
            )}
            <CloseButton onClick={close} />
          </div>

          <div ref={threadRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {item.status === 'watching' && item.waitFor && (
              <div className="flex items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-200">
                <span aria-hidden="true">👁</span>
                <span className="min-w-0 flex-1">
                  {waitingLabel(item.waitFor)}
                  <span className="ml-1.5 text-xs text-sky-300/70">since {messageTime(item.waitFor.since)}</span>
                </span>
              </div>
            )}
            {projectGateTarget(item.gate) && (
              <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                <p className="text-amber-200">Which project is this for? Haiku couldn't tell from the text.</p>
                <div className="flex flex-wrap gap-1.5">
                  {repos.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => onProject(item, r)}
                      className="cursor-pointer rounded bg-deck-700 px-2 py-1 text-xs hover:bg-deck-600"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {dirty && (
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setTitle(item.title)}
                  className="cursor-pointer rounded bg-deck-700 px-2 py-1 text-xs hover:bg-deck-600"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={!title.trim()}
                  className="cursor-pointer rounded bg-grass-600 px-2 py-1 text-xs hover:bg-grass-500 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            )}

            {item.steps.length > 1 && (
              // the flow's steps: done ✓, current ●, to come ○
              <ol className="flex flex-col gap-1 rounded-lg border border-deck-800 p-2.5 text-xs">
                {item.steps.map((s, k) => (
                  <li
                    key={`${s.prompt}-${s.waitFor ?? ''}-${s.gate}`}
                    className={`flex items-baseline gap-2 ${k === item.stepIndex ? 'text-deck-100' : 'text-deck-500'}`}
                  >
                    <span className="w-3 shrink-0">{k < item.stepIndex ? '✓' : k === item.stepIndex ? '●' : '○'}</span>
                    <span className="min-w-0 flex-1 truncate" title={s.prompt}>
                      {s.waitFor ? '👁 ' : ''}
                      {s.prompt}
                    </span>
                    {s.gate && <span className="shrink-0 text-deck-600">approve</span>}
                  </li>
                ))}
              </ol>
            )}
            {item.branch && (
              <p className="flex items-center gap-2 text-xs text-deck-500">
                <span title={item.checkout ?? undefined}>⎇ {item.branch}</span>
                {session && item.checkout && (
                  <button
                    type="button"
                    onClick={() => resumeInGhostty(item.checkout ?? '', session)}
                    className="cursor-pointer text-deck-400 hover:text-deck-200 hover:underline"
                  >
                    open session in Ghostty
                  </button>
                )}
              </p>
            )}

            {/* the thread: everything that happened to the item, one conversation */}
            <ol className="flex flex-col gap-2.5">
              {events.map((e, i) => {
                // shown as buttons (next step) or as the cards card (proposal), not as a raw line
                if (e.kind === 'next' || e.kind === 'proposal') return null
                const lastResult = e.kind === 'result' && i === lastResultAt
                if (e.kind === 'result')
                  return (
                    <li
                      key={e.id}
                      className={`rounded-lg border p-3 ${lastResult && item.status === 'needs_review' ? 'border-grass-500/40 bg-grass-600/10' : 'border-deck-700 bg-deck-800/60'}`}
                    >
                      <p className="mb-1.5 flex items-center gap-2 text-xs text-deck-400">
                        🤖 Result <span className="ml-auto">{messageTime(e.ts)}</span>
                      </p>
                      <Markdown text={e.text ?? ''} className="text-sm" />
                      {lastResult && item.status === 'needs_review' && !shaping && next && (
                        // Haiku's read of what comes next: each button sends its reply (shown) or finishes
                        <div className="mt-3 flex flex-col gap-2 border-t border-deck-700 pt-2.5">
                          {next.headline && <p className="text-xs text-deck-300">🤖 {next.headline}</p>}
                          <div className="flex flex-col gap-1.5">
                            {next.actions.map((a, k) => (
                              <button
                                key={a.label}
                                type="button"
                                onClick={() =>
                                  a.watch
                                    ? watchStream(item, a.watch, 'me')
                                    : a.reply
                                      ? sendReply(a.reply)
                                      : onAction(item, 'approve')
                                }
                                className={`flex cursor-pointer flex-col items-start rounded-md px-3 py-2 text-left ${
                                  k === 0
                                    ? 'bg-grass-600 text-white hover:bg-grass-500'
                                    : 'bg-deck-700 text-deck-100 hover:bg-deck-600'
                                }`}
                              >
                                <span className="text-sm font-semibold">{a.label}</span>
                                <span className={`text-xs ${k === 0 ? 'text-white/75' : 'text-deck-400'}`}>
                                  {a.watch
                                    ? `waits until: ${TRIGGERS.find((t) => t.value === a.watch)?.label.toLowerCase()}, then resumes`
                                    : a.reply
                                      ? `sends: “${a.reply}”`
                                      : item.steps[item.stepIndex + 1]
                                        ? `approves → step ${item.stepIndex + 2}`
                                        : 'marks it done'}
                                </span>
                              </button>
                            ))}
                          </div>
                          <p className="text-xs text-deck-500">
                            {next.actions.some((a) => !a.reply && !a.watch) ? (
                              'Or'
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => onAction(item, 'approve')}
                                  className="cursor-pointer text-deck-300 underline hover:text-deck-100"
                                >
                                  Mark done
                                </button>{' '}
                                or
                              </>
                            )}{' '}
                            write your own reply below.
                          </p>
                        </div>
                      )}
                      {lastResult && item.status === 'needs_review' && !shaping && !next && (
                        <div className="mt-3 flex items-center gap-2 border-t border-deck-700 pt-2.5">
                          <button
                            type="button"
                            onClick={() => onAction(item, 'approve')}
                            className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-grass-500"
                          >
                            {item.steps[item.stepIndex + 1] ? `Approve → step ${item.stepIndex + 2}` : 'Approve'}
                          </button>
                          {Date.now() - new Date(e.ts).getTime() < SUGGEST_WAIT_MS ? (
                            <span className="flex items-center gap-1.5 text-xs text-deck-400">
                              <span
                                aria-hidden="true"
                                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-deck-500 border-t-transparent"
                              />
                              Haiku is working out the next step…
                            </span>
                          ) : (
                            <span className="text-xs text-deck-500">or reply below to send it back with a note</span>
                          )}
                        </div>
                      )}
                    </li>
                  )
                if (e.kind === 'reply')
                  return (
                    <li
                      key={e.id}
                      className="ml-10 self-end whitespace-pre-wrap rounded-lg bg-deck-700 px-3 py-2 text-sm"
                    >
                      {e.text}
                    </li>
                  )
                // a trail line: one line, the full text on click
                const open = expanded.has(e.id)
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => toggle(e.id)}
                      title={open ? undefined : 'Show the full message'}
                      className="flex w-full cursor-pointer items-baseline gap-2 text-left text-xs text-deck-400 hover:text-deck-300"
                    >
                      <span title={e.actor} className="shrink-0">
                        {actorIcon(e.actor)}
                      </span>
                      <span
                        className={`min-w-0 flex-1 ${open ? 'whitespace-pre-wrap' : 'truncate'} ${e.kind === 'failed' ? 'text-red-300' : ''}`}
                      >
                        {eventText(e)}
                      </span>
                      <span className="shrink-0 text-deck-500">{messageTime(e.ts)}</span>
                    </button>
                  </li>
                )
              })}
              {proposal && item.status === 'needs_review' && (
                // the shaping agent's plan: create its cards, or reply below to change it
                <li className="flex flex-col gap-2.5 rounded-lg border border-grass-500/40 bg-grass-600/10 p-3">
                  <p className="text-xs text-deck-300">
                    🧭 {proposal.summary || 'Proposed cards'} · {proposal.cards.length} card
                    {proposal.cards.length === 1 ? '' : 's'}
                  </p>
                  <ol className="flex flex-col gap-1.5">
                    {proposal.cards.map((c, k) => (
                      <li key={c.title} className="rounded-md bg-deck-800/80 px-3 py-2">
                        <p className="text-sm font-medium text-deck-100">
                          <span className="mr-2 text-xs text-deck-500">{k + 1}</span>
                          {c.title}
                        </p>
                        {c.notes && <p className="mt-0.5 text-xs text-deck-400">{c.notes}</p>}
                      </li>
                    ))}
                  </ol>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => take(true)}
                      disabled={taking}
                      className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-grass-500"
                    >
                      Create {proposal.cards.length} card{proposal.cards.length === 1 ? '' : 's'} in Queued
                    </button>
                    <button
                      type="button"
                      onClick={() => take(false)}
                      disabled={taking}
                      className="cursor-pointer rounded-md bg-deck-700 px-3 py-1.5 text-sm text-deck-100 hover:bg-deck-600"
                    >
                      In Inbox
                    </button>
                    <span className="text-xs text-deck-500">or reply below to change the plan</span>
                  </div>
                </li>
              )}
              {run && item.status === 'running' && (
                <li className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="flex items-center gap-2 text-xs text-amber-300">
                    <span className="animate-pulse">● agent running</span>
                    <button
                      type="button"
                      onClick={() => cancelStreamItem(item)}
                      className="ml-auto cursor-pointer rounded bg-deck-700 px-2 py-0.5 text-deck-200 hover:bg-deck-600"
                    >
                      Cancel
                    </button>
                  </p>
                  {run.lines
                    .filter((l) => l.kind !== 'user')
                    .slice(-40)
                    .map((l, j) =>
                      l.kind === 'tool' ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: run lines are append-only
                        <p key={j} className="truncate font-mono text-[11px] text-deck-500">
                          › {l.text}
                        </p>
                      ) : l.kind === 'error' ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: run lines are append-only
                        <p key={j} className="text-xs text-red-300">
                          {l.text}
                        </p>
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: run lines are append-only
                        <Markdown key={j} text={l.text} className="text-sm" />
                      ),
                    )}
                </li>
              )}
            </ol>
          </div>

          {/* the composer: my reply goes into the item's session and the agent picks it up */}
          <div className="shrink-0 border-t border-deck-800 p-3">
            {canReply && (
              // one box, like a chat input: the text grows with its lines, send sits inside it
              <div className="mb-2 flex items-end gap-2 rounded-xl border border-deck-700 bg-deck-800/80 py-1.5 pr-1.5 pl-3.5 transition-colors focus-within:border-grass-500/70">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter sends, Shift+Enter breaks the line; never mid-composition (IME, dead keys)
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  rows={Math.min(Math.max(reply.split('\n').length, 1), 6)}
                  aria-label="Reply to the agent"
                  placeholder="Reply to the agent…"
                  className="min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-sm leading-relaxed text-deck-100 placeholder:text-deck-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={send}
                  disabled={!reply.trim()}
                  title="Send (↵) · new line (⇧↵)"
                  aria-label="Send"
                  className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-grass-600 text-white hover:bg-grass-500 disabled:cursor-default disabled:bg-deck-700 disabled:text-deck-500"
                >
                  <svg
                    width={16}
                    height={16}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.25}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                </button>
              </div>
            )}
            {(footerActions.length > 0 || canWatch) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {canWatch && (
                  // park the card on its PR: it resumes on its own when that happens
                  <select
                    value=""
                    onChange={(e) => {
                      const t = TRIGGERS.find((x) => x.value === e.target.value)
                      if (t) watchStream(item, t.value, 'me')
                    }}
                    aria-label="Wait on GitHub"
                    title="Wait on GitHub, then resume the agent"
                    className="cursor-pointer rounded bg-deck-700 px-2 py-1 text-xs text-deck-100 hover:bg-deck-600 focus:outline-none"
                  >
                    <option value="">👁 Wait on GitHub…</option>
                    {TRIGGERS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                )}
                {footerActions.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    title={a.title}
                    onClick={() => onAction(item, a.id)}
                    className={`cursor-pointer rounded px-2 py-1 text-xs ${
                      a.id === 'run' || a.id === 'retry'
                        ? 'bg-grass-600 text-white hover:bg-grass-500'
                        : 'bg-deck-700 hover:bg-deck-600'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </SidePanel>
  )
}
