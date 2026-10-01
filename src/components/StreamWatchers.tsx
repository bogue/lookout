import { useEffect, useState } from 'react'
import type { WatcherRun } from '../lib/config'
import type { FlowTemplate } from '../lib/streamflow'
import {
  DEFAULT_WATCHERS,
  WATCHER_CHECKS,
  type Watcher,
  type WatcherCheck,
  type WatcherModel,
} from '../lib/streamwatchers'
import { messageTime } from '../lib/time'
import type { WatchedRepo } from '../types'

type Props = {
  watchers: Watcher[]
  templates: FlowTemplate[]
  repos: WatchedRepo[]
  runs: Record<string, WatcherRun> // each watcher's last run
  onSave: (watchers: Watcher[]) => void
}

const control =
  'rounded-md border border-deck-700 bg-deck-800 px-2 py-1 text-xs text-deck-100 placeholder:text-deck-500 focus:border-deck-500 focus:outline-none'

const blank = (): Watcher => ({
  id: `watcher-${crypto.randomUUID().slice(0, 8)}`,
  name: 'New watcher',
  enabled: false,
  every: 30,
  repo: null,
  check: 'prompt',
  templateId: null,
  prompt: '',
  model: 'haiku',
  tools: '',
})

const lastRun = (r: WatcherRun | undefined) =>
  !r
    ? 'never ran'
    : r.error
      ? `last run ${messageTime(r.at)} · failed: ${r.error}`
      : `last run ${messageTime(r.at)} · ${r.made ? `${r.made} card${r.made === 1 ? '' : 's'}` : 'nothing new'}`

// The watchers: rules that create Stream cards on their own — from what Lookout's sync finds, or from
// a prompt a read-only agent checks. Edited as a draft and saved together. Their cards land in
// Queued, where the risk check holds anything outward-facing for my OK.
export const StreamWatchers = ({ watchers, templates, repos, runs, onSave }: Props) => {
  const [draft, setDraft] = useState(watchers)
  // reset only when the saved watchers change, not when another setting rebuilds the config
  const saved = JSON.stringify(watchers)
  useEffect(() => setDraft(JSON.parse(saved)), [saved])
  const dirty = JSON.stringify(draft) !== saved
  // a prompt watcher needs its prompt
  const valid = draft.every((w) => w.check !== 'prompt' || w.prompt.trim())

  const patch = (id: string, fn: (w: Watcher) => Watcher) => setDraft((d) => d.map((w) => (w.id === id ? fn(w) : w)))

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-deck-500">
        A watcher creates cards on its own: from what Lookout's sync finds (no extra GitHub calls), or from a prompt a
        read-only agent checks on its interval. One card per event, one at a time per PR. Cards land in Queued; the risk
        check holds anything outward-facing for your OK.
      </p>

      <ul className="flex flex-col gap-2">
        {draft.map((w) => (
          <li key={w.id} className="flex flex-col gap-2 rounded-lg border border-deck-700 bg-deck-800/40 p-2.5">
            <div className="flex items-center gap-2">
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
                className={`${control} min-w-0 flex-1 text-sm`}
              />
              <button
                type="button"
                onClick={() => setDraft((d) => d.filter((x) => x.id !== w.id))}
                className="shrink-0 cursor-pointer text-xs text-red-400 hover:text-red-300"
              >
                remove
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
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
            </div>

            {w.check === 'prompt' && (
              <div className="flex flex-col gap-2">
                <textarea
                  value={w.prompt}
                  onChange={(e) => patch(w.id, (x) => ({ ...x, prompt: e.target.value }))}
                  rows={3}
                  aria-label="What to check"
                  placeholder="What should it check? e.g. New Sentry crashes on wazo-mobile-native with more than 10 events since yesterday — a card per crash to fix."
                  className={`${control} w-full text-sm`}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={w.model}
                    onChange={(e) => patch(w.id, (x) => ({ ...x, model: e.target.value as WatcherModel }))}
                    aria-label="Model"
                    title="Haiku is cheap enough to run often"
                    className={`${control} cursor-pointer`}
                  >
                    <option value="haiku">Haiku</option>
                    <option value="sonnet">Sonnet</option>
                    <option value="default">My default model</option>
                  </select>
                  <input
                    value={w.tools}
                    onChange={(e) => patch(w.id, (x) => ({ ...x, tools: e.target.value }))}
                    aria-label="Extra tools"
                    placeholder="extra tools, e.g. mcp__sentry, mcp__notion"
                    title="Tools beyond reading files and gh. It can never write: every write is denied."
                    className={`${control} min-w-0 flex-1 font-mono`}
                  />
                </div>
              </div>
            )}

            <p className={`text-[11px] ${runs[w.id]?.error ? 'text-red-300' : 'text-deck-500'}`}>
              {lastRun(runs[w.id])}
            </p>
          </li>
        ))}
        {draft.length === 0 && <li className="text-sm text-deck-500">No watchers: cards only come from you.</li>}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setDraft((d) => [...d, blank()])}
          className="cursor-pointer rounded-md bg-deck-700 px-3 py-1.5 text-sm hover:bg-deck-600"
        >
          + Add watcher
        </button>
        <button
          type="button"
          onClick={() => setDraft(DEFAULT_WATCHERS)}
          className="cursor-pointer text-xs text-deck-400 hover:text-deck-200"
        >
          Reset to defaults
        </button>
        {dirty && (
          <div className="ml-auto flex items-center gap-2">
            {!valid && <span className="text-xs text-amber-300">A prompt watcher needs its prompt.</span>}
            <button
              type="button"
              onClick={() => setDraft(watchers)}
              className="cursor-pointer rounded-md bg-deck-700 px-3 py-1.5 text-sm hover:bg-deck-600"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={!valid}
              onClick={() =>
                onSave(
                  draft.map((w) => ({
                    ...w,
                    name: w.name.trim() || 'Watcher',
                    prompt: w.prompt.trim(),
                    tools: w.tools.trim(),
                  })),
                )
              }
              className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-grass-500 disabled:cursor-default disabled:opacity-40"
            >
              Save watchers
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
