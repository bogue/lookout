import { getVersion } from '@tauri-apps/api/app'
import { homeDir } from '@tauri-apps/api/path'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { open } from '@tauri-apps/plugin-dialog'
import { exists } from '@tauri-apps/plugin-fs'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { useEffect, useState } from 'react'
import { ACTION_ICON_NAMES, ActionIcon } from '../components/ActionIcon'
import { CommandTextarea } from '../components/CommandTextarea'
import { SidePanel } from '../components/SidePanel'
import { avatarUrl } from '../lib/avatar'
import { CONDITION_FIELDS } from '../lib/buttons'
import { listSlashCommands } from '../lib/commands'
import { DEFAULT_PR_BUTTONS, DEFAULT_REVIEW_BUTTONS } from '../lib/config'
import { allowPath } from '../lib/fsscope'
import { repoFromPath } from '../lib/gh'
import { clearLog, logPath } from '../lib/log'
import { notify } from '../lib/notify'
import { STAGES } from '../lib/stages'
import type { ActionButton, ButtonBoard, Config, ReviewTask, Stage, WatchedRepo } from '../types'
import { History } from './History'

type Props = {
  config: Config
  tasks: ReviewTask[]
  onSave: (repos: WatchedRepo[]) => void
  onSaveReviewButtons: (buttons: ActionButton[]) => void
  onSavePrButtons: (buttons: ActionButton[]) => void
  onSaveAnimations: (on: boolean) => void
  onSaveLogging: (on: boolean) => void
}

// one settings row: label, hint, and the pill switch on the right
const ToggleRow = ({
  label,
  hint,
  on,
  onToggle,
  children,
}: {
  label: string
  hint: string
  on: boolean
  onToggle: () => void
  children?: React.ReactNode // extra controls, shown under the row (e.g. the log file actions)
}) => (
  <div className="flex flex-col gap-2 rounded-lg border border-deck-700 p-3">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-deck-200">{label}</p>
        <p className="text-xs text-deck-500">{hint}</p>
      </div>
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
    </div>
    {children}
  </div>
)

const BOARD_META: Record<ButtonBoard, { title: string; hint: string }> = {
  review: {
    title: 'Review actions',
    hint: "Actions shown in a review card's panel. The first is the primary (used by the quick review shortcut).",
  },
  pr: {
    title: 'Pull Request actions',
    hint: "Actions shown in your own PR's panel. The first is the primary (used by the card's quick shortcut).",
  },
}

type EditorProps = {
  board: ButtonBoard
  hint: string
  buttons: ActionButton[]
  defaults: ActionButton[]
  commands: string[] // user's Claude slash-commands, for the prompt autocomplete
  onEdit: (buttons: ActionButton[]) => void // local update while typing (not persisted)
  onCommit: (buttons: ActionButton[]) => void // persist these buttons
  persist: () => void // persist current local buttons (used on blur)
}

// The full add/remove/edit UI for one board's actions. Rendered inside the side panel.
const ActionsEditor = ({ board, hint, buttons, defaults, commands, onEdit, onCommit, persist }: EditorProps) => {
  const fields = CONDITION_FIELDS[board]
  const labelCls = 'text-[11px] font-semibold uppercase tracking-wide text-deck-500'
  const patch = (id: string, p: Partial<ActionButton>, commit: boolean) => {
    const next = buttons.map((b) => (b.id === id ? { ...b, ...p } : b))
    ;(commit ? onCommit : onEdit)(next)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-deck-500">{hint}</p>
        <button
          type="button"
          onClick={() => onCommit(defaults)}
          className="shrink-0 cursor-pointer text-xs text-deck-400 hover:text-deck-200"
        >
          Reset to defaults
        </button>
      </div>

      {buttons.map((b, i) => (
        <div key={b.id} className="flex flex-col gap-3 rounded-md border border-deck-800 bg-deck-800/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className={labelCls}>
              {i === 0 ? 'Primary action' : `Action ${i + 1}`}
              {i === 0 && <span className="ml-1.5 normal-case text-deck-600">— used by the quick shortcut</span>}
            </span>
            <button
              type="button"
              onClick={() => onCommit(buttons.filter((x) => x.id !== b.id))}
              className="cursor-pointer text-xs text-red-400 hover:text-red-300"
            >
              remove
            </button>
          </div>

          {/* 1 — what the button says */}
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Button text</span>
            <input
              value={b.label}
              onChange={(e) => patch(b.id, { label: e.target.value }, false)}
              onBlur={persist}
              placeholder="e.g. do-review"
              className="rounded border border-deck-600 bg-deck-800 px-2 py-1 text-sm text-deck-100 outline-none focus:border-grass-500"
            />
          </label>

          {/* 1b — its icon */}
          <div className="flex flex-col gap-1">
            <span className={labelCls}>Icon</span>
            <div className="flex flex-wrap gap-1">
              {ACTION_ICON_NAMES.map((name) => {
                const on = (b.icon ?? 'play') === name
                return (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    onClick={() => patch(b.id, { icon: name }, true)}
                    className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded border ${
                      on
                        ? 'border-grass-500 bg-grass-600/20 text-grass-300'
                        : 'border-deck-600 text-deck-400 hover:bg-deck-700 hover:text-deck-200'
                    }`}
                  >
                    <ActionIcon name={name} size={16} />
                  </button>
                )
              })}
            </div>
          </div>

          {/* 2 — what it sends to claude */}
          <div className="flex flex-col gap-1">
            <span className={labelCls}>Prompt sent to claude</span>
            <CommandTextarea
              value={b.prompt}
              commands={commands}
              onChange={(v) => patch(b.id, { prompt: v }, false)}
              onBlur={persist}
              rows={3}
              placeholder="/do-review <pr_id>  — or a full prompt. Type / to insert one of your commands."
              className="w-full resize-y rounded border border-deck-600 bg-deck-800 px-2 py-1.5 font-mono text-xs text-deck-200 outline-none placeholder:text-deck-600 focus:border-grass-500"
            />
            <span className="text-[11px] text-deck-500">
              Placeholders: <code className="rounded bg-deck-800 px-1 text-grass-300">&lt;pr_id&gt;</code> (the PR
              number) and <code className="rounded bg-deck-800 px-1 text-grass-300">&lt;branch_name&gt;</code> (the PR's
              branch) are filled in when the action runs.
            </span>
          </div>

          {/* 3 — when the button is visible */}
          <div className="flex flex-col gap-1.5">
            <span className={labelCls}>
              Show when {b.conditions.length === 0 && <span className="normal-case text-deck-600">(always)</span>}
            </span>
            {b.conditions.map((c, idx) => {
              const field = fields.find((f) => f.field === c.field) ?? fields[0]
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: conditions are a positional list
                  key={idx}
                  className="flex items-start gap-2 rounded-md border border-deck-700 bg-deck-800/60 px-2 py-1.5"
                >
                  <span className="w-9 shrink-0 pt-1 text-right text-[11px] font-semibold text-deck-500">
                    {idx === 0 ? 'Where' : 'AND'}
                  </span>
                  <select
                    value={c.field}
                    onChange={(e) => {
                      const nextConds = b.conditions.map((x, j) =>
                        j === idx ? { field: e.target.value as typeof c.field, values: [] } : x,
                      )
                      patch(b.id, { conditions: nextConds }, true)
                    }}
                    className="w-32 shrink-0 cursor-pointer rounded border border-deck-600 bg-deck-800 px-1.5 py-0.5 text-xs text-deck-200 outline-none focus:border-grass-500"
                  >
                    {fields.map((f) => (
                      <option key={f.field} value={f.field}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <span className="shrink-0 pt-1 text-xs text-deck-500">is any of</span>
                  <div className="flex flex-1 flex-wrap gap-1">
                    {field.values.map(({ value, label }) => {
                      const on = c.values.includes(value)
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => {
                            const values = on ? c.values.filter((x) => x !== value) : [...c.values, value]
                            const nextConds = b.conditions.map((x, j) => (j === idx ? { ...x, values } : x))
                            patch(b.id, { conditions: nextConds }, true)
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
                  <button
                    type="button"
                    onClick={() => patch(b.id, { conditions: b.conditions.filter((_, j) => j !== idx) }, true)}
                    title="Remove condition"
                    className="shrink-0 cursor-pointer rounded border border-deck-600 px-1.5 py-0.5 text-sm leading-none text-deck-400 hover:border-red-400/50 hover:text-red-300"
                  >
                    −
                  </button>
                </div>
              )
            })}
            <button
              type="button"
              onClick={() =>
                patch(b.id, { conditions: [...b.conditions, { field: fields[0].field, values: [] }] }, true)
              }
              className="cursor-pointer self-start text-xs text-grass-400 hover:text-grass-300"
            >
              + add condition
            </button>
          </div>

          {/* 4 — where the card lands once the run finishes (review board only) */}
          {board === 'review' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>On completion</span>
              <div className="flex items-center gap-2 text-xs text-deck-400">
                move card to stage
                <select
                  value={b.advanceTo ?? ''}
                  onChange={(e) => patch(b.id, { advanceTo: (e.target.value || undefined) as Stage | undefined }, true)}
                  className="w-48 cursor-pointer rounded border border-deck-600 bg-deck-800 px-2 py-1 text-xs text-deck-200 outline-none focus:border-grass-500"
                >
                  <option value="">— leave unchanged —</option>
                  {STAGES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          )}
        </div>
      ))}

      <button
        type="button"
        onClick={() =>
          onCommit([...buttons, { id: crypto.randomUUID(), label: 'New action', prompt: '', conditions: [] }])
        }
        className="cursor-pointer self-start rounded-md border border-grass-600 px-3 py-1.5 text-sm text-grass-300 hover:bg-grass-600/20"
      >
        + Add action
      </button>
    </div>
  )
}

const PencilIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </svg>
)

// A read-only card previewing a board's actions as they render in the real panel; click to edit.
const ActionsPreview = ({
  title,
  hint,
  buttons,
  onEdit,
}: {
  title: string
  hint: string
  buttons: ActionButton[]
  onEdit: () => void
}) => (
  <div className="flex flex-col gap-2">
    <div>
      <h3 className="text-sm font-semibold text-deck-300">{title}</h3>
      <p className="text-xs text-deck-500">{hint}</p>
    </div>
    <button
      type="button"
      onClick={onEdit}
      title="Edit actions"
      className="group flex items-center justify-between gap-3 rounded-lg border border-deck-700 bg-deck-800/40 p-3 text-left hover:border-grass-600/60 hover:bg-deck-800"
    >
      <div className="flex flex-wrap gap-2">
        {buttons.length === 0 && <span className="text-sm text-deck-500">No actions yet — click to add one.</span>}
        {buttons.map((b, i) => (
          <span
            key={b.id}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
              i === 0 ? 'bg-grass-600 text-white' : 'border border-grass-600 text-grass-300'
            }`}
          >
            <ActionIcon name={b.icon} /> {b.label}
          </span>
        ))}
      </div>
      <span className="shrink-0 rounded-md border border-deck-600 p-1.5 text-deck-400 group-hover:border-grass-500 group-hover:text-grass-300">
        <PencilIcon />
      </span>
    </button>
  </div>
)

export const Settings = ({
  config,
  tasks,
  onSave,
  onSaveReviewButtons,
  onSavePrButtons,
  onSaveAnimations,
  onSaveLogging,
}: Props) => {
  const [path, setPath] = useState('')
  const [editing, setEditing] = useState<ButtonBoard | null>(null) // which board's actions are open in the side panel
  const [reviewBtns, setReviewBtns] = useState<ActionButton[]>(config.reviewButtons)
  const [prBtns, setPrBtns] = useState<ActionButton[]>(config.prButtons)
  const [commands, setCommands] = useState<string[]>([])

  // slash-commands for the prompt autocomplete: user commands + each watched repo's project commands
  useEffect(() => {
    listSlashCommands(config.repos.map((r) => r.path))
      .then(setCommands)
      .catch(() => setCommands([]))
  }, [config.repos])

  useEffect(() => {
    setReviewBtns(config.reviewButtons)
  }, [config.reviewButtons])
  useEffect(() => {
    setPrBtns(config.prButtons)
  }, [config.prButtons])
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [autostart, setAutostart] = useState(false)
  const [version, setVersion] = useState('')
  const [logFile, setLogFile] = useState('')

  useEffect(() => {
    isEnabled()
      .then(setAutostart)
      .catch(() => {})
    getVersion()
      .then(setVersion)
      .catch(() => {}) // browser preview (no tauri): just leave it out
    logPath()
      .then(setLogFile)
      .catch(() => {})
  }, [])

  const toggleAutostart = async () => {
    try {
      if (autostart) await disable()
      else await enable()
      setAutostart(await isEnabled())
    } catch {
      // autostart unavailable in dev builds
    }
  }

  const browse = async () => {
    const folder = await open({
      directory: true,
      multiple: false,
      defaultPath: `${await homeDir()}Projects`,
    })
    if (typeof folder === 'string') setPath(folder)
  }

  // Only the local path is entered; owner/repo is resolved from the clone's git origin.
  const add = async () => {
    const cleaned = path.trim().replace(/\/$/, '')
    if (!cleaned.startsWith('/')) return
    setAdding(true)
    setAddError(null)
    try {
      if (config.repos.some((r) => r.path === cleaned)) throw new Error('This path is already watched.')
      // the scope has to be widened before the check, or `exists` reports a forbidden path as a
      // missing one for every clone outside the paths the capability file can name
      await allowPath(cleaned)
      if (!(await exists(cleaned).catch(() => false))) throw new Error('Path not found.')
      const repo = await repoFromPath(cleaned).catch(() => null)
      if (!repo) throw new Error('No GitHub origin found — is this a git clone with an origin remote?')
      onSave([...config.repos, { repo, path: cleaned }])
      setPath('')
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  // Wire the ActionsEditor to one board's local state + persistence.
  const editorProps = (board: ButtonBoard) => {
    const isReview = board === 'review'
    const buttons = isReview ? reviewBtns : prBtns
    const setLocal = isReview ? setReviewBtns : setPrBtns
    const save = isReview ? onSaveReviewButtons : onSavePrButtons
    return {
      board,
      hint: BOARD_META[board].hint,
      buttons,
      defaults: isReview ? DEFAULT_REVIEW_BUTTONS : DEFAULT_PR_BUTTONS,
      commands,
      onEdit: setLocal,
      onCommit: (next: ActionButton[]) => {
        setLocal(next)
        save(next)
      },
      persist: () => save(buttons),
    }
  }

  return (
    <div className="flex max-w-[1000px] flex-col gap-8">
      <div>
        <h2 className="text-2xl font-bold">Settings</h2>
        {version && <p className="mt-0.5 text-xs font-light text-deck-500">v{version}</p>}
        <p className="mt-5 flex items-center gap-2 text-sm text-deck-400">
          {config.githubUser ? (
            <button
              type="button"
              onClick={() => openUrl(`https://github.com/${config.githubUser}`)}
              title="Open GitHub profile"
              className="flex cursor-pointer items-center gap-1.5 rounded-full bg-grass-600/20 py-0.5 pl-1 pr-2.5 font-medium text-grass-300 hover:bg-grass-600/35"
            >
              <img src={avatarUrl(config.githubUser)} alt={config.githubUser} className="h-5 w-5 rounded-full" />@
              {config.githubUser}
            </button>
          ) : (
            <span className="italic text-deck-500">(detected on first sync)</span>
          )}
          <span>— your own PRs are never listed.</span>
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-deck-300">Watched repositories</h3>
        <p className="mb-2 text-xs text-deck-500">
          This order drives the Discovery columns — drag a column title there to reorder.
        </p>
        <ul className="flex flex-col gap-1">
          {config.repos.map((r) => (
            <li
              key={r.path}
              className="flex items-center gap-2 rounded border border-deck-700 bg-deck-800/60 p-2 text-sm"
            >
              <span className="font-medium">{r.repo}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-deck-500">{r.path}</span>
              <button
                type="button"
                onClick={() => onSave(config.repos.filter((x) => x.path !== r.path))}
                className="cursor-pointer text-xs text-red-400 hover:text-red-300"
              >
                remove
              </button>
            </li>
          ))}
          {config.repos.length === 0 && <li className="text-sm text-deck-500">No repos watched yet.</li>}
        </ul>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-deck-700 p-3">
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="local clone path (e.g. /Users/you/Projects/my-repo)"
            className="flex-1 rounded border border-deck-600 bg-deck-800 px-2 py-1.5 text-sm outline-none focus:border-grass-500"
          />
          <button
            type="button"
            onClick={browse}
            className="cursor-pointer rounded-md border border-deck-600 px-3 py-1.5 text-sm text-deck-300 hover:bg-deck-700"
          >
            Browse…
          </button>
        </div>
        {addError && <p className="text-xs text-red-400">{addError}</p>}
        <button
          type="button"
          onClick={add}
          disabled={adding || !path.trim()}
          className="cursor-pointer self-start rounded-md bg-grass-600 px-3 py-1.5 text-sm hover:bg-grass-500 disabled:opacity-50"
        >
          {adding ? 'detecting repo…' : 'Add repo'}
        </button>
      </div>

      <ActionsPreview
        title={BOARD_META.review.title}
        hint={BOARD_META.review.hint}
        buttons={reviewBtns}
        onEdit={() => setEditing('review')}
      />

      <ActionsPreview
        title={BOARD_META.pr.title}
        hint={BOARD_META.pr.hint}
        buttons={prBtns}
        onEdit={() => setEditing('pr')}
      />

      <ToggleRow
        label="Launch at login"
        hint="Start Lookout automatically when you log in."
        on={autostart}
        onToggle={toggleAutostart}
      />

      <ToggleRow
        label="Animations"
        hint="Motion effects: the wordmark sheen and card glow while a claude run is live."
        on={config.animations}
        onToggle={() => onSaveAnimations(!config.animations)}
      />

      <ToggleRow
        label="Debug log"
        hint="Record gh calls, claude runs, sync and database errors to a file — what to read when something silently does nothing."
        on={config.logging}
        onToggle={() => onSaveLogging(!config.logging)}
      >
        {logFile && (
          <div className="flex items-center gap-2 border-t border-deck-800 pt-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-deck-500" title={logFile}>
              {logFile}
            </span>
            {/* both tolerate a log file that doesn't exist yet (nothing has been written) */}
            <button
              type="button"
              onClick={() => revealItemInDir(logFile).catch(() => {})}
              className="cursor-pointer rounded-md border border-deck-600 px-2 py-1 text-xs text-deck-300 hover:bg-deck-700"
            >
              Reveal
            </button>
            <button
              type="button"
              onClick={() => clearLog().catch(() => {})}
              className="cursor-pointer rounded-md border border-deck-600 px-2 py-1 text-xs text-deck-300 hover:bg-deck-700"
            >
              Clear
            </button>
          </div>
        )}
      </ToggleRow>

      {import.meta.env.DEV && (
        <div className="flex items-center justify-between rounded-lg border border-deck-700 p-3">
          <div>
            <p className="text-sm font-medium text-deck-200">Test notification</p>
            <p className="text-xs text-deck-500">Dev only — fire an OS notification to verify permissions.</p>
          </div>
          <button
            type="button"
            onClick={() => notify('Test notification', 'If you see this, OS notifications work.')}
            className="cursor-pointer rounded-md border border-deck-600 px-3 py-1.5 text-sm text-deck-300 hover:bg-deck-700"
          >
            Send test
          </button>
        </div>
      )}

      <div className="mt-6 border-t border-deck-800 pt-4">
        <History tasks={tasks} />
      </div>

      {editing && (
        <SidePanel onClose={() => setEditing(null)} initialWidth={620}>
          {({ close }) => (
            <>
              <div className="flex items-center justify-between border-b border-deck-800 px-4 py-3">
                <h2 className="text-lg font-semibold text-white">{BOARD_META[editing].title}</h2>
                <button
                  type="button"
                  onClick={close}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-xl leading-none text-deck-400 hover:text-deck-100"
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <ActionsEditor {...editorProps(editing)} />
              </div>
            </>
          )}
        </SidePanel>
      )}
    </div>
  )
}
