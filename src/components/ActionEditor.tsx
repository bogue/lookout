import type { ReactNode } from 'react'
import { appendToken, rulesLabel } from '../lib/actionlist'
import { CONDITION_FIELDS } from '../lib/buttons'
import { STAGES } from '../lib/stages'
import type { ActionButton, ButtonBoard, Stage } from '../types'
import { ACTION_ICON_NAMES, ActionIcon } from './ActionIcon'
import { CommandTextarea } from './CommandTextarea'
import { Tip } from './Tip'

type Props = {
  board: ButtonBoard
  button: ActionButton
  primary: boolean // first in the list: the one the card's quick shortcut runs
  commands: string[] // the user's slash commands, for the prompt autocomplete
  onChange: (p: Partial<ActionButton>, commit: boolean) => void // commit=false while typing, saved on blur
  onBlur: () => void
  onDelete: () => void
}

const labelCls = 'text-[11px] font-semibold uppercase tracking-wide text-deck-400'
const inputCls =
  'rounded border border-deck-600 bg-deck-800 px-2 py-1.5 text-sm text-deck-100 outline-none focus:border-grass-500'

// One titled block of the editor: small caps heading, optional note on its right
const Section = ({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) => (
  <section className="flex flex-col gap-3 rounded-lg border border-deck-700 bg-deck-800/40 p-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className={labelCls}>{title}</h3>
      {aside}
    </div>
    {children}
  </section>
)

const Switch = ({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={onToggle}
    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${on ? 'bg-grass-500' : 'bg-deck-600'}`}
  >
    <span
      className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${on ? 'translate-x-5' : ''}`}
    />
  </button>
)

// The action as the panel will draw it
export const ActionChip = ({ button, primary }: { button: ActionButton; primary: boolean }) => (
  <span
    className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
      primary ? 'bg-grass-600 text-white' : 'border border-grass-600 text-grass-300'
    }`}
  >
    <ActionIcon name={button.icon} />
    <span className="truncate">{button.label || 'Untitled'}</span>
  </span>
)

// Edit one action: what it shows, what it sends, when it's offered, what happens after.
export const ActionEditor = ({ board, button: b, primary, commands, onChange, onBlur, onDelete }: Props) => {
  const fields = CONDITION_FIELDS[board]
  const setConditions = (conditions: ActionButton['conditions']) => onChange({ conditions }, true)

  return (
    <div className="flex flex-col gap-3">
      <Section title="Button" aside={<ActionChip button={b} primary={primary} />}>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-deck-400">Text</span>
          <input
            value={b.label}
            onChange={(e) => onChange({ label: e.target.value }, false)}
            onBlur={onBlur}
            placeholder="e.g. Do review"
            className={inputCls}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-deck-400">Icon</span>
          <div className="flex flex-wrap gap-1">
            {ACTION_ICON_NAMES.map((name) => {
              const on = (b.icon ?? 'play') === name
              return (
                <Tip key={name} label={name}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange({ icon: name }, true)}
                    className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded border ${
                      on
                        ? 'border-grass-500 bg-grass-600/20 text-grass-300'
                        : 'border-deck-600 text-deck-400 hover:bg-deck-700 hover:text-deck-200'
                    }`}
                  >
                    <ActionIcon name={name} size={16} />
                  </button>
                </Tip>
              )
            })}
          </div>
        </div>
      </Section>

      <Section title="Prompt to Claude">
        <CommandTextarea
          value={b.prompt}
          commands={commands}
          onChange={(v) => onChange({ prompt: v }, false)}
          onBlur={onBlur}
          rows={4}
          placeholder="/do-review <pr_id>  — or a full prompt. Type / to insert one of your commands."
          className="w-full resize-y rounded border border-deck-600 bg-deck-800 px-2 py-1.5 font-mono text-xs text-deck-200 outline-none placeholder:text-deck-600 focus:border-grass-500"
        />
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-deck-500">
          Insert
          {[
            { token: '<pr_id>', hint: 'the PR number' },
            { token: '<branch_name>', hint: "the PR's branch" },
          ].map(({ token, hint }) => (
            <Tip key={token} label={`Filled with ${hint} when the action runs`}>
              <button
                type="button"
                onClick={() => onChange({ prompt: appendToken(b.prompt, token) }, true)}
                className="cursor-pointer rounded border border-grass-700/60 bg-grass-600/15 px-1.5 py-0.5 font-mono text-grass-300 hover:bg-grass-600/30"
              >
                {token} +
              </button>
            </Tip>
          ))}
        </div>
      </Section>

      <Section title="Show when" aside={<span className="text-xs text-deck-500">{rulesLabel(b.conditions)}</span>}>
        {b.conditions.length === 0 && <p className="text-xs text-deck-500">Shown on every card.</p>}
        {b.conditions.map((c, idx) => {
          const field = fields.find((f) => f.field === c.field) ?? fields[0]
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: conditions are a positional list
              key={idx}
              className="flex flex-col gap-2 rounded-md border border-deck-700 bg-deck-800/60 p-2"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-deck-700 px-1.5 py-0.5 text-[11px] font-semibold text-deck-300">
                  {idx === 0 ? 'Where' : 'And'}
                </span>
                <select
                  value={c.field}
                  onChange={(e) =>
                    setConditions(
                      b.conditions.map((x, j) =>
                        j === idx ? { field: e.target.value as typeof c.field, values: [] } : x,
                      ),
                    )
                  }
                  className="cursor-pointer rounded border border-deck-600 bg-deck-800 px-1.5 py-0.5 text-xs text-deck-200 outline-none focus:border-grass-500"
                >
                  {fields.map((f) => (
                    <option key={f.field} value={f.field}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-deck-500">is any of</span>
                <Tip label="Remove this rule">
                  <button
                    type="button"
                    onClick={() => setConditions(b.conditions.filter((_, j) => j !== idx))}
                    className="ml-auto cursor-pointer rounded border border-deck-600 px-1.5 py-0.5 text-sm leading-none text-deck-400 hover:border-red-400/50 hover:text-red-300"
                  >
                    −
                  </button>
                </Tip>
              </div>
              <div className="flex flex-wrap gap-1">
                {field.values.map(({ value, label }) => {
                  const on = c.values.includes(value)
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const values = on ? c.values.filter((x) => x !== value) : [...c.values, value]
                        setConditions(b.conditions.map((x, j) => (j === idx ? { ...x, values } : x)))
                      }}
                      className={`cursor-pointer rounded px-1.5 py-0.5 text-xs ${
                        on ? 'bg-grass-600 text-white' : 'border border-deck-600 text-deck-400 hover:bg-deck-700'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
        <button
          type="button"
          onClick={() => setConditions([...b.conditions, { field: fields[0].field, values: [] }])}
          className="cursor-pointer self-start text-xs text-grass-400 hover:text-grass-300"
        >
          + Add condition
        </button>
      </Section>

      {/* the Pull Requests board has no stages to move to and keeps no reports */}
      {board === 'review' && (
        <Section title="On completion">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-deck-200">Move card to stage</p>
              <p className="text-xs text-deck-500">Where the card goes once the run finishes</p>
            </div>
            <select
              value={b.advanceTo ?? ''}
              onChange={(e) => onChange({ advanceTo: (e.target.value || undefined) as Stage | undefined }, true)}
              className="w-44 cursor-pointer rounded border border-deck-600 bg-deck-800 px-2 py-1 text-xs text-deck-200 outline-none focus:border-grass-500"
            >
              <option value="">Leave unchanged</option>
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-deck-200">Save answer as report</p>
              <p className="text-xs text-deck-500">Keep Claude's final answer on the card, as a report</p>
            </div>
            <Switch
              on={b.saveReport !== 'off'}
              label="Save answer as report"
              onToggle={() => onChange({ saveReport: b.saveReport === 'off' ? undefined : 'off' }, true)}
            />
          </div>
          {b.saveReport !== 'off' && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-deck-500">Saved as</p>
              <select
                value={b.saveReport ?? ''}
                onChange={(e) =>
                  onChange({ saveReport: (e.target.value || undefined) as ActionButton['saveReport'] }, true)
                }
                className="w-44 cursor-pointer rounded border border-deck-600 bg-deck-800 px-2 py-1 text-xs text-deck-200 outline-none focus:border-grass-500"
              >
                <option value="">Auto-detect</option>
                <option value="review">Review</option>
                <option value="followup">Follow-up</option>
              </select>
            </div>
          )}
        </Section>
      )}

      <button
        type="button"
        onClick={onDelete}
        className="mt-2 cursor-pointer self-start rounded-md border border-red-500/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-600/15"
      >
        Delete action
      </button>
    </div>
  )
}
