import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { editStreamItem, streamEvents } from '../lib/db'
import { resumeInGhostty } from '../lib/ghostty'
import { logError } from '../lib/log'
import { getRuns, subscribeRuns } from '../lib/runs'
import { projectGateTarget, prRefOf, STATUS_LABEL, type StreamActionId, streamActions } from '../lib/stream'
import { cancelStreamItem, replyStreamItem, streamTaskId } from '../lib/streamrunner'
import { messageTime } from '../lib/time'
import type { StreamEvent, StreamItem } from '../types'
import { CloseButton } from './CloseButton'
import { Markdown } from './Markdown'
import { PrLink } from './PrLink'
import { SidePanel } from './SidePanel'

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
  const [body, setBody] = useState(item.body ?? '')
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [reply, setReply] = useState('')
  const runs = useSyncExternalStore(subscribeRuns, getRuns)
  const run = runs.find((r) => r.taskId === streamTaskId(item.id))
  const session = item.sessionIds.at(-1) ?? null
  const canReply = !!session && !!item.checkout && item.status !== 'running'
  const lastResultAt = events.map((e) => e.kind).lastIndexOf('result')

  const send = async () => {
    const text = reply.trim()
    if (!text) return
    setReply('')
    try {
      await replyStreamItem(item, text)
    } catch (e) {
      logError('stream', e, 'reply to stream item')
      setReply(text) // keep what I typed
    }
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
            <CloseButton onClick={close} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
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
            <details open={!!item.body} className="group text-xs text-deck-400">
              <summary className="cursor-pointer select-none">Notes for the agent</summary>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                placeholder="Context for the agent: links, constraints, what done looks like…"
                className="mt-1.5 w-full rounded-md border border-deck-700 bg-deck-800/80 px-3 py-2 text-sm text-deck-100 placeholder:text-deck-500 focus:border-deck-500 focus:outline-none"
              />
            </details>
            {dirty && (
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setTitle(item.title)
                    setBody(item.body ?? '')
                  }}
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
                      {lastResult && item.status === 'needs_review' && (
                        <div className="mt-3 flex items-center gap-2 border-t border-deck-700 pt-2.5">
                          <button
                            type="button"
                            onClick={() => onAction(item, 'approve')}
                            className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-grass-500"
                          >
                            Approve
                          </button>
                          <span className="text-xs text-deck-500">or reply below to send it back with a note</span>
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
                return (
                  <li key={e.id} className="flex items-baseline gap-2 text-xs text-deck-400">
                    <span title={e.actor} className="shrink-0">
                      {actorIcon(e.actor)}
                    </span>
                    <span className={`min-w-0 flex-1 ${e.kind === 'failed' ? 'text-red-300' : ''}`}>
                      {eventText(e)}
                    </span>
                    <span className="shrink-0 text-deck-500">{messageTime(e.ts)}</span>
                  </li>
                )
              })}
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
              <div className="mb-2 flex items-end gap-2">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.metaKey) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  rows={2}
                  placeholder="Reply to the agent — a note on the result, an answer, “push it and open a PR”…"
                  className="min-w-0 flex-1 resize-none rounded-md border border-deck-700 bg-deck-800/80 px-3 py-2 text-sm text-deck-100 placeholder:text-deck-500 focus:border-deck-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={send}
                  disabled={!reply.trim()}
                  className="h-9 shrink-0 cursor-pointer rounded-md bg-grass-600 px-3 text-sm font-semibold text-white hover:bg-grass-500 disabled:cursor-default disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {streamActions(item)
                .filter((a) => a.id !== 'approve') // the result card carries it
                .map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    title={a.title}
                    onClick={() => onAction(item, a.id)}
                    className={`cursor-pointer rounded px-2 py-1 text-xs ${
                      a.danger
                        ? 'bg-red-600/20 text-red-300 hover:bg-red-600/40'
                        : a.id === 'run' || a.id === 'retry'
                          ? 'bg-grass-600 text-white hover:bg-grass-500'
                          : 'bg-deck-700 hover:bg-deck-600'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
            </div>
          </div>
        </>
      )}
    </SidePanel>
  )
}
