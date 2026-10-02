import { useEffect, useState } from 'react'
import { DEFAULT_TEMPLATES, type FlowTemplate, type TemplateStep } from '../lib/streamflow'
import { TRIGGERS, type Trigger } from '../lib/streamwatch'

type Props = {
  templates: FlowTemplate[]
  onSave: (templates: FlowTemplate[]) => void
}

const field =
  'w-full rounded-md border border-deck-700 bg-deck-800/80 px-2.5 py-1.5 text-sm text-deck-100 placeholder:text-deck-500 focus:border-deck-500 focus:outline-none'

const newStep = (): TemplateStep => ({ prompt: '', gate: true })

// Settings → Stream flows: named step lists the dump's Flow picker offers. Edited as a draft and
// saved together, so a half-typed step never reaches the board. A card copies its flow when created,
// so editing one here changes no card already on the board.
export const StreamTemplates = ({ templates, onSave }: Props) => {
  const [draft, setDraft] = useState(templates)
  const [open, setOpen] = useState<string | null>(null)
  // Reset the draft only when the saved flows really change: any other setting saved rebuilds the
  // config (a new array, same content), and that must not wipe what I'm typing here.
  const saved = JSON.stringify(templates)
  useEffect(() => setDraft(JSON.parse(saved)), [saved])

  const dirty = JSON.stringify(draft) !== JSON.stringify(templates)
  // a flow needs a name and at least one step with a prompt
  const valid = draft.every((t) => t.name.trim() && t.steps.some((s) => s.prompt.trim()))

  const patch = (id: string, fn: (t: FlowTemplate) => FlowTemplate) =>
    setDraft((d) => d.map((t) => (t.id === id ? fn(t) : t)))
  const patchStep = (id: string, k: number, fn: (s: TemplateStep) => TemplateStep) =>
    patch(id, (t) => ({ ...t, steps: t.steps.map((s, i) => (i === k ? fn(s) : s)) }))

  const save = () =>
    onSave(
      draft.map((t) => ({
        ...t,
        name: t.name.trim(),
        guidelines: t.guidelines.trim(),
        steps: t.steps.filter((s) => s.prompt.trim()).map((s) => ({ ...s, prompt: s.prompt.trim() })),
      })),
    )

  const add = () => {
    const id = `flow-${crypto.randomUUID().slice(0, 8)}`
    setDraft((d) => [...d, { id, name: 'New flow', guidelines: '', steps: [newStep()] }])
    setOpen(id)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-deck-200">Stream flows</h3>
          <p className="mt-0.5 text-xs text-deck-500">
            Step lists a Stream card can follow, picked in the dump box. A step can be a skill (/review &lt;pr_id&gt;)
            or a plain prompt; &lt;pr_id&gt;, &lt;branch_name&gt; and &lt;title&gt; are filled in. "Approve" stops for
            you; "wait" parks the card on its PR until that happens.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setDraft(DEFAULT_TEMPLATES)}
            className="cursor-pointer rounded-md bg-deck-700 px-3 py-1.5 text-sm hover:bg-deck-600"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={add}
            className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-grass-500"
          >
            + Add flow
          </button>
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {draft.map((t) => (
          <li key={t.id} className="rounded-lg border border-deck-700 bg-deck-800/40">
            <button
              type="button"
              onClick={() => setOpen(open === t.id ? null : t.id)}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
            >
              <span className="text-xs text-deck-500">{open === t.id ? '▾' : '▸'}</span>
              <span className="text-sm font-medium text-deck-100">{t.name || '(no name)'}</span>
              <span className="text-xs text-deck-500">
                {t.steps.length} step{t.steps.length === 1 ? '' : 's'}
              </span>
            </button>
            {open === t.id && (
              <div className="flex flex-col gap-3 border-t border-deck-700 p-3">
                <input
                  value={t.name}
                  onChange={(e) => patch(t.id, (x) => ({ ...x, name: e.target.value }))}
                  aria-label="Flow name"
                  placeholder="Flow name"
                  className={field}
                />
                <textarea
                  value={t.guidelines}
                  onChange={(e) => patch(t.id, (x) => ({ ...x, guidelines: e.target.value }))}
                  rows={2}
                  aria-label="Guidelines"
                  placeholder="Guidelines added to every step — e.g. never push without asking, run pnpm test first"
                  className={field}
                />
                <ol className="flex flex-col gap-2">
                  {t.steps.map((s, k) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: steps are edited in place; their order is their identity
                    <li key={k} className="flex flex-col gap-1.5 rounded-md border border-deck-700 p-2">
                      <div className="flex items-center gap-2 text-xs text-deck-400">
                        <span className="font-semibold text-deck-300">Step {k + 1}</span>
                        <label className="flex cursor-pointer items-center gap-1">
                          <input
                            type="checkbox"
                            checked={s.gate}
                            onChange={(e) => patchStep(t.id, k, (x) => ({ ...x, gate: e.target.checked }))}
                          />
                          approve before going on
                        </label>
                        <select
                          value={s.waitFor ?? ''}
                          onChange={(e) =>
                            patchStep(t.id, k, (x) => {
                              const { waitFor: _, ...rest } = x
                              return e.target.value ? { ...rest, waitFor: e.target.value as Trigger } : rest
                            })
                          }
                          aria-label="Wait first"
                          className="cursor-pointer rounded bg-deck-800 px-1.5 py-0.5 text-deck-200 focus:outline-none"
                        >
                          <option value="">no wait</option>
                          {TRIGGERS.map((tr) => (
                            <option key={tr.value} value={tr.value}>
                              wait first: {tr.label.toLowerCase()}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => patch(t.id, (x) => ({ ...x, steps: x.steps.filter((_, i) => i !== k) }))}
                          disabled={t.steps.length === 1}
                          className="ml-auto cursor-pointer text-red-400 hover:text-red-300 disabled:cursor-default disabled:opacity-40"
                        >
                          remove
                        </button>
                      </div>
                      <textarea
                        value={s.prompt}
                        onChange={(e) => patchStep(t.id, k, (x) => ({ ...x, prompt: e.target.value }))}
                        rows={2}
                        aria-label={`Step ${k + 1} prompt`}
                        placeholder="/review <pr_id>, or what the agent should do"
                        className={field}
                      />
                    </li>
                  ))}
                </ol>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => patch(t.id, (x) => ({ ...x, steps: [...x.steps, newStep()] }))}
                    className="cursor-pointer text-xs text-grass-300 hover:text-grass-200"
                  >
                    + Add step
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraft((d) => d.filter((x) => x.id !== t.id))}
                    className="cursor-pointer text-xs text-red-400 hover:text-red-300"
                  >
                    Delete flow
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
        {draft.length === 0 && <li className="text-sm text-deck-500">No flows. Cards run as a single step.</li>}
      </ul>

      {dirty && (
        <div className="flex items-center justify-end gap-2">
          {!valid && <span className="text-xs text-amber-300">Each flow needs a name and a step with a prompt.</span>}
          <button
            type="button"
            onClick={() => setDraft(templates)}
            className="cursor-pointer rounded-md bg-deck-700 px-3 py-1.5 text-sm hover:bg-deck-600"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!valid}
            className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-grass-500 disabled:cursor-default disabled:opacity-40"
          >
            Save flows
          </button>
        </div>
      )}
    </div>
  )
}
