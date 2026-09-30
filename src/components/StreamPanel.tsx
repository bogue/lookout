import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useState } from 'react'
import { editStreamItem, streamEvents } from '../lib/db'
import { logError } from '../lib/log'
import { projectGateTarget, prRefOf, STATUS_LABEL, type StreamActionId, streamActions } from '../lib/stream'
import { messageTime } from '../lib/time'
import type { StreamEvent, StreamItem } from '../types'
import { CloseButton } from './CloseButton'
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

// An item's side panel: edit it, act on it, and read its trail. The dispatch thread (phase 3) grows
// out of this feed.
export const StreamPanel = ({ item, version, repos, onAction, onProject, onEdited, onClose }: Props) => {
  const [title, setTitle] = useState(item.title)
  const [body, setBody] = useState(item.body ?? '')
  const [events, setEvents] = useState<StreamEvent[]>([])

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
            <label className="flex flex-col gap-1 text-xs text-deck-400">
              Notes
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Context for the agent: links, constraints, what done looks like…"
                className="rounded-md border border-deck-700 bg-deck-800/80 px-3 py-2 text-sm text-deck-100 placeholder:text-deck-500 focus:border-deck-500 focus:outline-none"
              />
            </label>
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

            <div className="flex flex-wrap gap-1.5">
              {streamActions(item).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  title={a.title}
                  onClick={() => onAction(item, a.id)}
                  className={`cursor-pointer rounded px-2 py-1 text-xs ${
                    a.danger ? 'bg-red-600/20 text-red-300 hover:bg-red-600/40' : 'bg-deck-700 hover:bg-deck-600'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>

            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-deck-400">Activity</h4>
              <ol className="flex flex-col gap-1.5">
                {events.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2 text-sm">
                    <span title={e.actor} className="shrink-0">
                      {actorIcon(e.actor)}
                    </span>
                    <span className="min-w-0 flex-1 text-deck-200">{eventText(e)}</span>
                    <span className="shrink-0 text-xs text-deck-500">{messageTime(e.ts)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}
    </SidePanel>
  )
}
