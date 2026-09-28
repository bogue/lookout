import { getVersion } from '@tauri-apps/api/app'
import { homeDir } from '@tauri-apps/api/path'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open } from '@tauri-apps/plugin-dialog'
import { exists } from '@tauri-apps/plugin-fs'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { useEffect, useState } from 'react'
import { ActionChip, ActionEditor } from '../components/ActionEditor'
import { type Confirm, ConfirmDialog } from '../components/ConfirmDialog'
import { SidePanel } from '../components/SidePanel'
import { dropAction } from '../lib/actionlist'
import { avatarUrl } from '../lib/avatar'
import { listSlashCommands } from '../lib/commands'
import { DEFAULT_PR_BUTTONS, DEFAULT_REVIEW_BUTTONS } from '../lib/config'
import { capturedReviewCount, clearCapturedReviews } from '../lib/db'
import { allowPath } from '../lib/fsscope'
import { repoFromPath } from '../lib/gh'
import { clearLog, logPath } from '../lib/log'
import { notify } from '../lib/notify'
import type { ActionButton, ButtonBoard, Config, ReviewTask, WatchedRepo } from '../types'
import { History } from './History'

type Props = {
  config: Config
  tasks: ReviewTask[]
  onSave: (repos: WatchedRepo[]) => void
  onSaveReviewButtons: (buttons: ActionButton[]) => void
  onSavePrButtons: (buttons: ActionButton[]) => void
  onSaveAnimations: (on: boolean) => void
  onSaveLogging: (on: boolean) => void
  onSaveCaptureReviews: (on: boolean) => void
  onSaveOpenInBrowser: (on: boolean) => void
}

// What to paste into ~/.claude/settings.json for instant capture. Lookout does not write that file
// itself: it is the user's own config, shared with every other tool, and a merge gone wrong there is
// worse than a copy-paste.
const HOOK_SNIPPET = JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'lookout review capture --hook', timeout: 10 }] }] } },
  null,
  2,
)

// one settings row: label, hint, and the pill switch on the right
const ToggleRow = ({
  label,
  hint,
  on,
  onToggle,
  children,
  bare,
}: {
  label: string
  hint: string
  on: boolean
  onToggle: () => void
  children?: React.ReactNode // extra controls, shown under the row (e.g. the log file actions)
  bare?: boolean // a row inside a grouped list: the list draws the border
}) => (
  <div className={`flex flex-col gap-2 p-3 ${bare ? '' : 'rounded-lg border border-deck-700'}`}>
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
    hint: "Buttons in a review card's panel. The first one is the primary: the review shortcut runs it.",
  },
  pr: {
    title: 'Pull Request actions',
    hint: "Buttons in your own PR's panel. The first one is the primary: the card's shortcut runs it.",
  },
}

const iconBtn =
  'flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-deck-600 text-deck-400 hover:bg-deck-700 hover:text-deck-100 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent'

const PencilIcon = () => (
  <svg
    width="14"
    height="14"
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

const TrashIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)

const GripIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {[5, 12, 19].flatMap((y) => [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />))}
  </svg>
)

// the one badge a row carries: the report it saves, when the action says which (auto-detect and
// "don't save" show nothing)
const REPORT_BADGE: Partial<Record<NonNullable<ActionButton['saveReport']>, string>> = {
  review: '📄 Review report',
  followup: '📋 Follow-up report',
}

// One board's actions as a list you can clearly add to, reorder (drag the handle), edit and delete
// from. Clicking a row opens that action alone in the side panel.
const ActionList = ({
  board,
  buttons,
  onOpen,
  onAdd,
  onReorder,
  onDelete,
  onReset,
}: {
  board: ButtonBoard
  buttons: ActionButton[]
  onOpen: (id: string) => void
  onAdd: () => void
  onReorder: (id: string, beforeId: string | null) => void
  onDelete: (b: ActionButton) => void
  onReset: () => void
}) => {
  const [dragging, setDragging] = useState<string | null>(null)
  // insertion line: above row `before`, or under the last row when null
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  const endDrag = () => {
    setDragging(null)
    setDropBefore(undefined)
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-deck-200">{BOARD_META[board].title}</h3>
          <p className="mt-0.5 text-xs text-deck-500">{BOARD_META[board].hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button type="button" onClick={onReset} className="cursor-pointer text-xs text-deck-500 hover:text-deck-200">
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={onAdd}
            className="cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-grass-500"
          >
            + Add action
          </button>
        </div>
      </div>
      <ul
        onDragOver={(e) => dragging && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          if (dragging && dropBefore !== undefined) onReorder(dragging, dropBefore)
          endDrag()
        }}
        className="flex flex-col rounded-lg border border-deck-700 bg-deck-800/40"
      >
        {buttons.length === 0 && (
          <li className="p-4 text-sm text-deck-500">No actions yet. Add one to get a button in the panel.</li>
        )}
        {buttons.map((b, i) => {
          const badge = b.saveReport && REPORT_BADGE[b.saveReport]
          const lineAbove = dragging && dropBefore === b.id
          const lineBelow = dragging && dropBefore === null && i === buttons.length - 1
          return (
            <li
              key={b.id}
              onDragOver={(e) => {
                if (!dragging) return
                e.preventDefault()
                // top half of a row drops before it, bottom half before the next one
                const r = e.currentTarget.getBoundingClientRect()
                setDropBefore(e.clientY < r.top + r.height / 2 ? b.id : (buttons[i + 1]?.id ?? null))
              }}
              className={`relative flex items-center gap-3 p-2.5 ${i > 0 ? 'border-t border-deck-800' : ''} ${
                dragging === b.id ? 'opacity-40' : ''
              }`}
            >
              {lineAbove && <span className="absolute inset-x-2 -top-px h-0.5 rounded bg-grass-400" />}
              {lineBelow && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-grass-400" />}
              {/* drag by the handle only, so a click on the row still opens it */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag handle, like the board's draggable cards */}
              <span
                draggable
                title="Drag to reorder — the first action is the primary"
                onDragStart={(e) => {
                  const row = e.currentTarget.closest('li')
                  if (row) e.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2)
                  e.dataTransfer.setData('text/plain', b.id) // WebKit won't start a drag without it
                  e.dataTransfer.effectAllowed = 'move'
                  setDragging(b.id)
                }}
                onDragEnd={endDrag}
                className="flex h-7 w-6 cursor-grab items-center justify-center text-deck-500 hover:text-deck-200 active:cursor-grabbing"
              >
                <GripIcon />
              </span>
              <button
                type="button"
                onClick={() => onOpen(b.id)}
                title="Edit this action"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded text-left"
              >
                <ActionChip button={b} primary={i === 0} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-deck-500">
                  {b.prompt || 'no prompt yet'}
                </span>
                {badge && (
                  <span className="shrink-0 rounded bg-deck-700 px-1.5 py-0.5 text-[11px] text-deck-300">{badge}</span>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" title="Edit" onClick={() => onOpen(b.id)} className={iconBtn}>
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={() => onDelete(b)}
                  className={`${iconBtn} hover:border-red-400/50 hover:text-red-300`}
                >
                  <TrashIcon />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export const Settings = ({
  config,
  tasks,
  onSave,
  onSaveReviewButtons,
  onSavePrButtons,
  onSaveAnimations,
  onSaveLogging,
  onSaveCaptureReviews,
  onSaveOpenInBrowser,
}: Props) => {
  const [editing, setEditing] = useState<{ board: ButtonBoard; id: string } | null>(null) // the one action open in the side panel
  const [confirm, setConfirm] = useState<Confirm | null>(null) // a destructive change waiting for a yes
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
  const [captured, setCaptured] = useState(0)
  const [copiedHook, setCopiedHook] = useState(false)

  // re-read after each sync: a pass can capture a review while this page is open
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh trigger only
  useEffect(() => {
    capturedReviewCount()
      .then(setCaptured)
      .catch(() => {}) // browser preview (no database): the count just stays at 0
  }, [tasks])

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

  // Pick a clone and watch it straight away: owner/repo is resolved from its git origin, so the
  // folder is all there is to choose.
  const addRepo = async () => {
    setAddError(null)
    const folder = await open({ directory: true, multiple: false, defaultPath: `${await homeDir()}Projects` }).catch(
      () => null,
    )
    if (typeof folder !== 'string') return // cancelled
    const cleaned = folder.replace(/\/$/, '')
    setAdding(true)
    try {
      if (config.repos.some((r) => r.path === cleaned)) throw new Error(`${cleaned} is already watched.`)
      // the scope has to be widened before the check, or `exists` reports a forbidden path as a
      // missing one for every clone outside the paths the capability file can name
      await allowPath(cleaned)
      if (!(await exists(cleaned).catch(() => false))) throw new Error('Path not found.')
      const repo = await repoFromPath(cleaned).catch(() => null)
      if (!repo) throw new Error(`No GitHub origin in ${cleaned} — is it a git clone with an origin remote?`)
      onSave([...config.repos, { repo, path: cleaned }])
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  // One board's local buttons + persistence. Typing only updates the local copy (saved on blur);
  // every other change is saved straight away.
  const boardApi = (board: ButtonBoard) => {
    const isReview = board === 'review'
    const buttons = isReview ? reviewBtns : prBtns
    const setLocal = isReview ? setReviewBtns : setPrBtns
    const save = isReview ? onSaveReviewButtons : onSavePrButtons
    const commit = (next: ActionButton[]) => {
      setLocal(next)
      save(next)
    }
    return {
      buttons,
      commit,
      patch: (id: string, p: Partial<ActionButton>, persist: boolean) =>
        (persist ? commit : setLocal)(buttons.map((b) => (b.id === id ? { ...b, ...p } : b))),
      persist: () => save(buttons),
      add: () => {
        const b: ActionButton = { id: crypto.randomUUID(), label: 'New action', prompt: '', conditions: [] }
        commit([...buttons, b])
        setEditing({ board, id: b.id })
      },
      remove: (b: ActionButton) =>
        setConfirm({
          title: 'Delete this action?',
          body: `"${b.label || 'Untitled'}" disappears from the panel. This can't be undone.`,
          confirmLabel: 'Delete',
          onConfirm: () => {
            commit(buttons.filter((x) => x.id !== b.id))
            setEditing((cur) => (cur?.id === b.id ? null : cur))
          },
        }),
      reset: () =>
        setConfirm({
          title: `Reset ${BOARD_META[board].title.toLowerCase()}?`,
          body: 'Every action on this list is replaced by the defaults. Your own actions and edits are lost.',
          confirmLabel: 'Reset to defaults',
          onConfirm: () => {
            commit(isReview ? DEFAULT_REVIEW_BUTTONS : DEFAULT_PR_BUTTONS)
            setEditing(null)
          },
        }),
    }
  }

  const list = (board: ButtonBoard) => {
    const api = boardApi(board)
    return (
      <ActionList
        board={board}
        buttons={api.buttons}
        onOpen={(id) => setEditing({ board, id })}
        onAdd={api.add}
        onReorder={(id, beforeId) => api.commit(dropAction(api.buttons, id, beforeId))}
        onDelete={api.remove}
        onReset={api.reset}
      />
    )
  }

  const openBoard = editing && boardApi(editing.board)
  const editingIndex = openBoard ? openBoard.buttons.findIndex((b) => b.id === editing?.id) : -1
  const editingButton = openBoard && editingIndex >= 0 ? openBoard.buttons[editingIndex] : null

  return (
    <div className="flex max-w-[1000px] flex-col gap-10">
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

      <div className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-deck-200">Watched repositories</h3>
            <p className="mt-0.5 text-xs text-deck-500">
              Pick a local clone to watch its PRs. This order drives the Discovery columns — drag a column title there
              to reorder.
            </p>
          </div>
          <button
            type="button"
            onClick={addRepo}
            disabled={adding}
            className="shrink-0 cursor-pointer rounded-md bg-grass-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-grass-500 disabled:cursor-default disabled:opacity-60"
          >
            {adding ? 'Detecting…' : '+ Add repo'}
          </button>
        </div>
        {addError && <p className="text-xs text-red-400">{addError}</p>}
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
          {config.repos.length === 0 && (
            <li className="text-sm text-deck-500">No repos watched yet. Add one to see its PRs.</li>
          )}
        </ul>
      </div>

      {list('review')}

      {list('pr')}

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-lg font-semibold text-deck-200">General</h3>
          <p className="mt-0.5 text-xs text-deck-500">How Lookout starts, opens links and moves.</p>
        </div>
        <div className="flex flex-col divide-y divide-deck-800 rounded-lg border border-deck-700">
          <ToggleRow
            bare
            label="Launch at login"
            hint="Start Lookout automatically when you log in."
            on={autostart}
            onToggle={toggleAutostart}
          />

          <ToggleRow
            bare
            label="Open links in your default browser"
            hint="PR links and GitHub pages open in your default browser instead of Lookout's own window. Off: a click opens Lookout's window and ⌘-click the browser — on, it's the other way round."
            on={config.openInBrowser}
            onToggle={() => onSaveOpenInBrowser(!config.openInBrowser)}
          />

          <ToggleRow
            bare
            label="Animations"
            hint="Motion effects: the wordmark sheen and card glow while a claude run is live."
            on={config.animations}
            onToggle={() => onSaveAnimations(!config.animations)}
          />
        </div>
      </div>

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

      <ToggleRow
        label="Capture reviews"
        hint="Keep the review a session printed but never saved, so it shows on the card. Skipped for a repo whose review command already writes AI_TASKS/code-review — that report is used instead. A month is kept."
        on={config.captureReviews}
        onToggle={() => onSaveCaptureReviews(!config.captureReviews)}
      >
        <div className="flex flex-col gap-2 border-t border-deck-800 pt-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-deck-500">
              {captured === 0 ? 'nothing captured yet' : `${captured} review${captured > 1 ? 's' : ''} stored`}
            </span>
            <button
              type="button"
              onClick={() => {
                writeText(HOOK_SNIPPET)
                  .then(() => {
                    setCopiedHook(true)
                    setTimeout(() => setCopiedHook(false), 1500)
                  })
                  .catch(() => {}) // no clipboard (browser preview): leave the label alone
              }}
              className="cursor-pointer rounded-md border border-deck-600 px-2 py-1 text-xs text-deck-300 hover:bg-deck-700"
            >
              {copiedHook ? 'copied ✓' : 'Copy hook'}
            </button>
            <button
              type="button"
              onClick={() =>
                clearCapturedReviews()
                  .then(() => setCaptured(0))
                  .catch(() => {})
              }
              className="cursor-pointer rounded-md border border-deck-600 px-2 py-1 text-xs text-deck-300 hover:bg-deck-700"
            >
              Clear
            </button>
          </div>
          {/* the sync pass already captures on its own; the hook is only about it being instant */}
          <p className="text-xs text-deck-500">
            A review shows up on the next sync. To have it land the moment a session stops, paste the copied Stop hook
            into <span className="font-mono">~/.claude/settings.json</span> (needs the{' '}
            <span className="font-mono">lookout</span> CLI on your PATH).
          </p>
        </div>
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

      {editing && openBoard && editingButton && (
        <SidePanel onClose={() => setEditing(null)} initialWidth={560}>
          {({ close }) => (
            <>
              <div className="flex items-center gap-2 border-b border-deck-800 px-4 py-3">
                <button
                  type="button"
                  onClick={close}
                  title="Back to the list"
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-xl leading-none text-deck-400 hover:text-deck-100"
                >
                  ‹
                </button>
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-white">Edit an action</h2>
                  <p className="text-xs text-deck-500">{BOARD_META[editing.board].title}</p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <ActionEditor
                  board={editing.board}
                  button={editingButton}
                  primary={editingIndex === 0}
                  commands={commands}
                  onChange={(p, persist) => openBoard.patch(editingButton.id, p, persist)}
                  onBlur={openBoard.persist}
                  onDelete={() => openBoard.remove(editingButton)}
                />
              </div>
            </>
          )}
        </SidePanel>
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
