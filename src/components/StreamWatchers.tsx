import { useEffect, useState } from 'react'
import type { FlowTemplate } from '../lib/streamflow'
import { DEFAULT_WATCHERS, WATCHER_CHECKS, type Watcher, type WatcherCheck } from '../lib/streamwatchers'
import type { WatchedRepo } from '../types'

type Props = {
  watchers: Watcher[]
  templates: FlowTemplate[]
  repos: WatchedRepo[]
  onSave: (watchers: Watcher[]) => void
}

const control =
  'rounded-md border border-deck-700 bg-deck-800 px-2 py-1 text-xs text-deck-100 focus:border-deck-500 focus:outline-none'

// Settings → Stream watchers: rules that create Stream cards from what the sync finds. Edited as a
// draft and saved together. A card they create lands in Queued; the risk check decides whether it
// may start without me.
export const StreamWatchers = ({ watchers, templates, repos, onSave }: Props) => {
  const [draft, setDraft] = useState(watchers)
  // reset only when the saved watchers change, not when another setting rebuilds the config
  const saved = JSON.stringify(watchers)
  useEffect(() => setDraft(JSON.parse(saved)), [saved])
  const dirty = JSON.stringify(draft) !== saved

  const patch = (id: string, fn: (w: Watcher) => Watcher) => setDraft((d) => d.map((w) => (w.id === id ? fn(w) : w)))

  const add = () =>
    setDraft((d) => [
      ...d,
      {
        id: `watcher-${crypto.randomUUID().slice(0, 8)}`,
        name: 'New watcher',
        enabled: false,
        every: 15,
        repo: null,
        check: 'review_requested',
        templateId: null,
      },
    ])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-deck-200">Stream watchers</h3>
          <p className="mt-0.5 text-xs text-deck-500">
            Rules that create Stream cards on their own, from what Lookout's sync finds — no extra GitHub calls. One
            card per event, and one at a time per PR. Cards land in Queued; the risk check holds anything outward-
            facing for your OK.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setDraft(DEFAULT_WATCHERS)}
            className="cursor-pointer rounded-md bg-deck-700 px-3 py-1.5 text-sm hover:bg-deck-600"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={add}
            className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-grass-500"
          >
            + Add watcher
          </button>
        </div>
      </div>

      <ul className="flex flex-col divide-y divide-deck-800 rounded-lg border border-deck-700">
        {draft.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center gap-2 p-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={w.enabled}
              aria-label={`${w.name}: ${w.enabled ? 'on' : 'off'}`}
              onClick={() => patch(w.id, (x) => ({ ...x, enabled: !x.enabled }))}
              className={`relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors ${w.enabled ? 'bg-grass-500' : 'bg-deck-600'}`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${w.enabled ? 'left-3.5' : 'left-0.5'}`}
              />
            </button>
            <input
              value={w.name}
              onChange={(e) => patch(w.id, (x) => ({ ...x, name: e.target.value }))}
              aria-label="Watcher name"
              className={`${control} w-48`}
            />
            <select
              value={w.check}
              onChange={(e) => patch(w.id, (x) => ({ ...x, check: e.target.value as WatcherCheck }))}
              aria-label="When"
              className={`${control} cursor-pointer`}
            >
              {WATCHER_CHECKS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              value={w.repo ?? ''}
              onChange={(e) => patch(w.id, (x) => ({ ...x, repo: e.target.value || null }))}
              aria-label="Project"
              className={`${control} max-w-[12rem] cursor-pointer truncate`}
            >
              <option value="">All projects</option>
              {repos.map((r) => (
                <option key={r.repo} value={r.repo}>
                  {r.repo}
                </option>
              ))}
            </select>
            <select
              value={w.templateId ?? ''}
              onChange={(e) => patch(w.id, (x) => ({ ...x, templateId: e.target.value || null }))}
              aria-label="Flow"
              className={`${control} cursor-pointer`}
            >
              <option value="">No flow (one step)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-deck-400">
              every
              <input
                type="number"
                min={1}
                value={w.every}
                onChange={(e) => patch(w.id, (x) => ({ ...x, every: Math.max(1, Number(e.target.value) || 1) }))}
                aria-label="Every (minutes)"
                className={`${control} w-14`}
              />
              min
            </label>
            <button
              type="button"
              onClick={() => setDraft((d) => d.filter((x) => x.id !== w.id))}
              className="ml-auto cursor-pointer text-xs text-red-400 hover:text-red-300"
            >
              remove
            </button>
          </li>
        ))}
        {draft.length === 0 && <li className="p-3 text-sm text-deck-500">No watchers: cards only come from you.</li>}
      </ul>

      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setDraft(watchers)}
            className="cursor-pointer rounded-md bg-deck-700 px-3 py-1.5 text-sm hover:bg-deck-600"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => onSave(draft.map((w) => ({ ...w, name: w.name.trim() || 'Watcher' })))}
            className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-grass-500"
          >
            Save watchers
          </button>
        </div>
      )}
    </div>
  )
}
