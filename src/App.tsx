import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { GlobalSearch } from './components/GlobalSearch'
import { NotificationBell } from './components/NotificationBell'
import { SessionPanel } from './components/SessionPanel'
import { visibleButtons } from './lib/buttons'
import { ACTION_TOOLS } from './lib/claude'
import {
  DEFAULT_PR_BUTTONS,
  DEFAULT_REVIEW_BUTTONS,
  getConfig,
  setAnimations,
  setPrButtons,
  setRepos,
  setReviewButtons,
} from './lib/config'
import {
  addSessionId,
  allAlerts,
  allMyPrs,
  allTasks,
  archiveAlert,
  archiveAllAlerts,
  clearNewActivity,
  markAlertRead,
  markAllAlertsRead,
  setFollowupSummary,
  setLinks,
  setMyPrColumn,
  setMyPrOrders,
  setOrders,
  setPrState,
  setSeen,
  setSnoozed,
  setStage,
  upsertMyPr,
} from './lib/db'
import type { TimelineSummary } from './lib/feed'
import { syncMyPrs } from './lib/myprs'
import { onNotificationClick } from './lib/notify'
import { classifyColumn } from './lib/prboard'
import { resolveColumn } from './lib/prcolumns'
import { fillPrompt } from './lib/prompt'
import { sortReposByNames } from './lib/repoorder'
import { scanReviewFiles } from './lib/reviews'
import { cancelRun, closeRun, getRun, getRuns, killRun, replyRun, resumeRun, startRun, subscribeRuns } from './lib/runs'
import { sessionCwd } from './lib/sessions'
import { advanceStage } from './lib/stages'
import { syncAll, syncTaskAlerts } from './lib/sync'
import { initTray, setTrayCount, showMainWindow } from './lib/tray'
import { pathForBranch } from './lib/worktrees'
import type {
  ActionButton,
  Alert,
  ButtonBoard,
  Config,
  MyPr,
  PrColumn,
  PrState,
  ReviewTask,
  Stage,
  WatchedRepo,
} from './types'
import { Board } from './views/Board'
import { Discovery } from './views/Discovery'
import { PullRequests } from './views/PullRequests'
import { Settings } from './views/Settings'

const POLL_MS = 10 * 60 * 1000
// on tab change we do a lightweight sync of just that tab's data, but not more often than this
const MIN_PARTIAL_MS = 60 * 1000

type View = 'pulls' | 'discovery' | 'board' | 'settings'

// Single source of truth for tab order: shortcuts (⌘1..⌘n) derive from the index
const TAB_ORDER: { view: View; label: string }[] = [
  { view: 'pulls', label: 'Pull Requests' },
  { view: 'board', label: 'Reviews' },
  { view: 'discovery', label: 'Discovery' },
  { view: 'settings', label: 'Settings' },
]

const parseFollowupSummary = (text: string) => {
  const m = text.match(/(\d+)\s*addressed\D*?(\d+)\s*partial\D*?(\d+)\s*pending/i)
  return m ? { addressed: Number(m[1]), partial: Number(m[2]), pending: Number(m[3]) } : null
}

const App = () => {
  const [view, setView] = useState<View>('board')
  const [config, setConfig] = useState<Config>({
    githubUser: '',
    githubName: '',
    repos: [],
    reviewButtons: DEFAULT_REVIEW_BUTTONS,
    prButtons: DEFAULT_PR_BUTTONS,
    animations: true,
  })
  const [tasks, setTasks] = useState<ReviewTask[]>([])
  const [myPrs, setMyPrs] = useState<MyPr[]>([])
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  const [panelTaskId, setPanelTaskId] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])

  const runs = useSyncExternalStore(subscribeRuns, getRuns)
  // last successful sync per data source, to throttle the on-tab-change partial syncs
  const tasksSyncedAt = useRef(0)
  const pullsSyncedAt = useRef(0)
  const busy = useRef(false)

  const reload = useCallback(async () => setTasks(await allTasks()), [])

  // The PR board reads its own table, so it paints immediately at launch instead of staying blank
  // until the first sync answers (which used to mean ~28 s, since refresh() awaited syncAll first).
  const reloadMyPrs = useCallback(async () => setMyPrs(await allMyPrs()), [])

  const reloadAlerts = useCallback(async () => setAlerts(await allAlerts()), [])

  // serialize syncs (never overlap) and surface the shared syncing/error/lastSync UI state
  const runSync = useCallback(async (fn: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true
    setSyncing(true)
    setError(null)
    try {
      await fn()
      setLastSync(new Date())
    } catch (e) {
      setError(String(e))
    } finally {
      busy.current = false
      setSyncing(false)
    }
  }, [])

  // partial: Reviews + Discovery share the tasks dataset (syncAll)
  const syncTasks = useCallback(
    () =>
      runSync(async () => {
        setTasks(await syncAll())
        setAlerts(await allAlerts())
        tasksSyncedAt.current = Date.now()
      }),
    [runSync],
  )

  // partial: the Pull Requests board
  const syncPulls = useCallback(
    () =>
      runSync(async () => {
        setMyPrs(await syncMyPrs())
        setAlerts(await allAlerts())
        pullsSyncedAt.current = Date.now()
      }),
    [runSync],
  )

  // full sync: mount, the 10-min poll, the manual button, and after editing repos
  const refresh = useCallback(
    () =>
      runSync(async () => {
        const cfg = await getConfig()
        setConfig(cfg)
        // run both boards at once: the PR board used to queue behind ~17 s of Reviews sync
        const [tasks, prs] = await Promise.all([syncAll(), syncMyPrs(cfg)])
        setTasks(tasks)
        setMyPrs(prs)
        setAlerts(await allAlerts())
        const now = Date.now()
        tasksSyncedAt.current = now
        pullsSyncedAt.current = now
      }),
    [runSync],
  )

  // change tab + kick a throttled partial sync of that tab's data (manual button stays the full sync)
  const switchView = useCallback(
    (v: View) => {
      setView(v)
      const now = Date.now()
      // runSync drops a call while another sync is in flight; that's fine here because the boards
      // now paint from their tables, so there is never a blank waiting on this
      if ((v === 'board' || v === 'discovery') && now - tasksSyncedAt.current >= MIN_PARTIAL_MS) syncTasks()
      else if (v === 'pulls' && now - pullsSyncedAt.current >= MIN_PARTIAL_MS) syncPulls()
    },
    [syncTasks, syncPulls],
  )

  useEffect(() => {
    initTray()
    getConfig().then(setConfig)
    reload()
    reloadMyPrs()
    reloadAlerts()
    refresh()
    const interval = setInterval(refresh, POLL_MS)
    return () => clearInterval(interval)
  }, [refresh, reload, reloadMyPrs, reloadAlerts])

  // The `lookout` CLI pings the app's socket after it writes, so a card moved from a terminal shows
  // up at once instead of at the next sync. The event is only a hint that something changed —
  // reload() reads the database for the truth, so a missed or malformed ping costs nothing.
  useEffect(() => {
    const sub = listen('cards:changed', () => {
      reload()
      reloadAlerts()
    }).catch(() => null)
    return () => {
      sub.then((un) => un?.())
    }
  }, [reload, reloadAlerts])

  // OS notification click: mark read + open the card panel (plugin only delivers clicks on mobile today)
  useEffect(() => {
    const listener = onNotificationClick(async ({ alertKey, taskId }) => {
      if (alertKey) await markAlertRead(alertKey)
      await reloadAlerts()
      await showMainWindow()
      if (taskId) {
        setView('board')
        setPanelTaskId(taskId)
      }
    }).catch(() => null)
    return () => {
      listener.then((l) => l?.unregister())
    }
  }, [reloadAlerts])

  // ⌘1..⌘n switch tabs, indexes follow TAB_ORDER
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const idx = Number(e.key) - 1
      if (e.metaKey && !e.shiftKey && !e.altKey && TAB_ORDER[idx]) {
        e.preventDefault()
        switchView(TAB_ORDER[idx].view)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [switchView])

  const moveStage = async (id: string, stage: Stage) => {
    await setStage(id, stage)
    if (stage === 'done') closeRun(id) // done = my part is over, no reply expected
    await reload()
  }

  const markSeen = async (id: string, seen: boolean) => {
    await setSeen(id, seen)
    await reload()
  }

  // Discovery column drag = the watched-repo order in settings; no re-sync needed, just persist + re-read
  const reorderRepos = async (repoNames: string[]) => {
    await setRepos(sortReposByNames(config.repos, repoNames))
    setConfig(await getConfig())
  }

  const saveRepos = async (repos: WatchedRepo[]) => {
    await setRepos(repos)
    setConfig(await getConfig())
    refresh()
  }

  // link the report a just-finished /do-review wrote, without waiting for the next full sync
  const linkReviewReport = async (taskId: string) => {
    const t = (await allTasks()).find((x) => x.id === taskId)
    if (!t?.repoPath) return
    const byBranch = await scanReviewFiles(t.repoPath).catch(() => new Map<string, string[]>())
    // /do-review flattens "/" in branch names when building the report filename
    const files = byBranch.get(t.branch) ?? byBranch.get(t.branch.replace(/\//g, '-')) ?? []
    if (files.length) await setLinks(t.id, t.sessionIds, files)
  }

  // A finished run changes what the bell should say about that PR (a report now exists, or the author's
  // fixes just landed), so re-derive its alerts right away instead of waiting for the next poll.
  const refreshTaskAlerts = async (taskId: string) => {
    const t = (await allTasks()).find((x) => x.id === taskId)
    if (!t) return
    await syncTaskAlerts(t, config.githubUser)
    await reloadAlerts()
  }

  // Post-run behavior is routed by board, not by a fixed command name.
  const runCallbacks = (board: ButtonBoard, button?: ActionButton) => {
    // PR board runs act on my own PRs (not tracked in the tasks DB): just re-derive the board on result
    if (board === 'pr')
      return {
        onResult: async () => {
          setMyPrs(await syncMyPrs())
        },
      }
    return {
      onSession: async (taskId: string, sessionId: string) => {
        await addSessionId(taskId, sessionId)
        await reload()
      },
      onResult: async (taskId: string, result: string) => {
        // any button whose prompt emits a "SUMMARY: … addressed … partial … pending" line updates the badge
        const summary = parseFollowupSummary(result)
        if (summary) await setFollowupSummary(taskId, summary)
        await linkReviewReport(taskId)
        // forward-only: a re-review on a follow-up card leaves it in Follow-up
        if (button?.advanceTo) {
          const cur = (await allTasks()).find((x) => x.id === taskId)?.stage
          const next = cur ? advanceStage(cur, button.advanceTo) : button.advanceTo
          if (next !== cur) await setStage(taskId, next)
        }
        await refreshTaskAlerts(taskId)
        await reload()
      },
    }
  }

  // Start a configurable button's prompt as a claude run for the given task/board.
  // Runs from wherever the branch is checked out: a PR branch is usually in a worktree, and starting
  // in the clone would leave claude on whatever unrelated branch the clone happens to sit on.
  const runButton = async (t: ReviewTask, board: ButtonBoard, button: ActionButton) => {
    if (!t.repoPath) return
    setPanelTaskId(t.id)
    const prompt = fillPrompt(button.prompt, t.branch, t.prNumber)
    const cwd = await pathForBranch(t.repoPath, t.branch)
    await startRun(t.id, button.label, board, prompt, cwd, runCallbacks(board, button), ACTION_TOOLS)
  }

  // Discovery / search "review" shortcut: add the PR to the board, then run the first review button.
  const startReview = async (id: string) => {
    const t = tasks.find((x) => x.id === id)
    const button = config.reviewButtons[0]
    if (!t || !button) return
    const stage = advanceStage(t.stage, 'reviewing')
    if (stage !== t.stage) await setStage(t.id, stage)
    await reload()
    await runButton({ ...t, stage }, 'review', button)
  }

  // adapt a MyPr into the ReviewTask shape SessionPanel consumes (my PRs aren't in the tasks DB)
  const myPrToTask = (pr: MyPr): ReviewTask => ({
    id: pr.id,
    repo: pr.repo,
    repoPath: pr.repoPath,
    branch: pr.branch,
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.url,
    prState: pr.state,
    prAuthor: config.githubUser,
    prCreatedAt: pr.createdAt,
    isDraft: pr.isDraft,
    stage: 'reviewing',
    column: pr.column, // drives PR-board button conditions
    reviewRequested: false,
    sessionIds: [],
    reviewFiles: [],
    followupSummary: null,
    activityCount: null,
    ciState: pr.ciState,
    hasNewActivity: false,
    snoozed: false,
    seen: true,
    sortOrder: null,
    doneAt: null,
    updatedAt: pr.createdAt,
  })

  // PR card shortcut: open the panel; run the first PR button only if nothing is already live for this PR
  const onHandleReview = (pr: MyPr) => {
    setPanelTaskId(pr.id)
    const button = config.prButtons[0]
    if (button && !getRun(pr.id)) runButton(myPrToTask(pr), 'pr', button)
  }

  // drag-drop on the PR board (optimistic): the drop is the placement, in either direction. It sticks
  // because derived_column is left as it was — the next sync sees GitHub hasn't changed its mind and
  // leaves the card alone (src/lib/prcolumns.ts).
  const reorderMyPr = async (pr: MyPr, column: PrColumn, orderedIds: string[]) => {
    const pos = new Map(orderedIds.map((id, i) => [id, (i + 1) * 10]))
    setMyPrs((prev) =>
      prev.map((p) => {
        const sortOrder = pos.get(p.id) ?? p.sortOrder
        return p.id === pr.id ? { ...p, column, sortOrder } : { ...p, sortOrder }
      }),
    )
    if (pr.column !== column) await setMyPrColumn(pr.id, column)
    await setMyPrOrders(orderedIds)
  }

  // Per-card refresh on open (PR board): re-derive the opened card from the timeline just fetched for
  // its feed, without a full list sync. Only review verdicts + PR state come from the timeline;
  // CI/draft stay as the last sync left them. Goes through resolveColumn and the table like any sync,
  // so opening a card can never demote it and the placement survives the next poll.
  const refreshMyPrFromTimeline = async (id: string, s: TimelineSummary) => {
    const prev = myPrs.find((p) => p.id === id)
    if (!prev) return
    const state = s.prState ?? prev.state
    const derivedColumn = classifyColumn({ state, isDraft: prev.isDraft, humanReview: s.humanReview })
    const next: MyPr = {
      ...prev,
      state,
      humanReview: s.humanReview,
      botReview: s.botReview,
      derivedColumn,
      column: resolveColumn(prev.column, prev.derivedColumn, derivedColumn),
      doneAt: state === 'open' ? null : (prev.doneAt ?? new Date().toISOString()),
    }
    setMyPrs((cur) => cur.map((p) => (p.id === id ? next : p)))
    await upsertMyPr(next)
  }

  // Per-card refresh on open (Reviews board): only PR state is safely derivable from the timeline
  // (activity uses a different counting path in the full sync, CI isn't in the timeline at all).
  const refreshTaskFromTimeline = async (id: string, prState: PrState | null) => {
    const t = tasks.find((x) => x.id === id)
    if (!prState || !t || t.prState === prState) return
    await setPrState(id, prState)
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, prState } : x)))
  }

  const openCard = (t: ReviewTask) => {
    setView('board')
    setPanelTaskId(t.id)
  }

  const openAlert = async (a: Alert) => {
    await markAlertRead(a.key)
    await reloadAlerts()
    if (a.kind === 'awaiting_me') {
      setView('pulls')
      setPanelTaskId(a.taskId)
      return
    }
    const t = tasks.find((x) => x.id === a.taskId)
    if (t) openCard(t)
  }

  const panelReviewTask = panelTaskId ? (tasks.find((t) => t.id === panelTaskId) ?? null) : null
  const panelPr = panelTaskId ? (myPrs.find((p) => p.id === panelTaskId) ?? null) : null
  const panelIsPr = !panelReviewTask && !!panelPr
  const panelTask = panelReviewTask ?? (panelPr ? myPrToTask(panelPr) : null)

  const discoveredCount = tasks.filter((t) => t.stage === 'discovered' && t.prState === 'open' && !t.seen).length
  const attentionCount =
    discoveredCount +
    runs.filter((r) => r.status === 'awaiting-input').length +
    tasks.filter((t) => t.hasNewActivity).length

  useEffect(() => {
    setTrayCount(attentionCount)
  }, [attentionCount])

  // The notification center is the single source of truth for "needs my attention": a card glows and a
  // tab is badged exactly while it has an unread alert, so the bell, the tabs and the boards never disagree.
  const alertedIds = new Set(alerts.filter((a) => !a.read).map((a) => a.taskId))
  const badges: Partial<Record<View, number>> = {
    board: tasks.filter((t) => alertedIds.has(t.id)).length,
    pulls: myPrs.filter((p) => alertedIds.has(p.id)).length,
  }

  // clicking a card is reading its notifications
  const markCardRead = async (id: string) => {
    const keys = alerts.filter((a) => a.taskId === id && !a.read).map((a) => a.key)
    if (!keys.length) return
    for (const k of keys) await markAlertRead(k)
    await reloadAlerts()
  }

  const tab = ({ view: v, label }: (typeof TAB_ORDER)[number], index: number) => {
    const badge = badges[v]
    return (
      <button
        key={v}
        type="button"
        onClick={() => switchView(v)}
        className={`group cursor-pointer rounded-md px-3 py-1.5 text-sm ${view === v ? 'bg-deck-700 text-white' : 'text-deck-400 hover:text-deck-200'}`}
      >
        {label}
        {badge ? (
          <span
            title="Unread notifications on this board"
            className={`ml-1.5 rounded-full px-1.5 text-xs ${v === 'discovery' ? 'bg-deck-700 text-deck-300' : 'bg-amber-500 text-black'}`}
          >
            {badge}
          </span>
        ) : null}
        <span className={`ml-1.5 text-xs ${view === v ? 'text-deck-400' : 'text-deck-600 group-hover:text-deck-500'}`}>
          ⌘{index + 1}
        </span>
      </button>
    )
  }

  // any live claude run makes the wordmark shimmer (Settings > Animations turns the motion off)
  const anyRunning = runs.some((r) => r.status === 'running')

  return (
    <div
      className={`flex h-screen flex-col overflow-hidden bg-deck-900 text-deck-100 ${config.animations ? '' : 'no-anim'}`}
    >
      {/* doubles as the window titlebar (overlay style): drag region + left inset for traffic lights;
          h matches the 46px the traffic_light y=25.5 is tuned for */}
      <header
        data-tauri-drag-region
        className="flex h-[46px] shrink-0 items-center gap-2 border-b border-deck-800 bg-deck-900 pl-[101px] pr-4"
      >
        {/* the wordmark doubles as a home button: back to the first tab */}
        <h1 data-tauri-drag-region className="mr-3">
          <button
            type="button"
            onClick={() => switchView(TAB_ORDER[0].view)}
            title={anyRunning ? 'A claude run is live' : `Back to ${TAB_ORDER[0].label}`}
            className={`font-script cursor-default select-none text-xl text-white transition-transform duration-200 hover:-rotate-2 hover:scale-105 ${anyRunning ? 'wordmark-running' : ''}`}
          >
            Lookout
          </button>
        </h1>
        {TAB_ORDER.filter((t) => t.view !== 'settings').map((t) => tab(t, TAB_ORDER.indexOf(t)))}
        {/* drag region only fires on the element itself, so the wrapper needs it too:
            clicks on the search input/buttons inside still behave normally */}
        <div data-tauri-drag-region className="flex min-w-0 flex-1 justify-center px-4">
          <GlobalSearch
            tasks={tasks}
            onOpen={openCard}
            onReview={startReview}
            onWatch={(id) => moveStage(id, 'watching')}
            onIgnore={(id) => moveStage(id, 'ignored')}
            onUnignore={(id) => moveStage(id, 'discovered')}
          />
        </div>
        {TAB_ORDER.filter((t) => t.view === 'settings').map((t) => tab(t, TAB_ORDER.indexOf(t)))}
        <NotificationBell
          alerts={alerts}
          onOpen={openAlert}
          onArchive={async (a) => {
            await archiveAlert(a.key)
            await reloadAlerts()
          }}
          onMarkAllRead={async () => {
            await markAllAlertsRead()
            await reloadAlerts()
          }}
          onArchiveAll={async () => {
            await archiveAllAlerts()
            await reloadAlerts()
          }}
        />
      </header>

      {/* status bar: above the board, but under the card side panel (z-20) */}
      <div className="fixed bottom-2 right-2 z-10 flex items-center gap-2 rounded-md border border-deck-700 bg-deck-900/95 px-2 py-1 text-xs text-deck-500 shadow-lg">
        {lastSync && <span>synced {lastSync.toLocaleTimeString()}</span>}
        <button
          type="button"
          onClick={refresh}
          disabled={syncing}
          className="cursor-pointer rounded bg-deck-800 px-2 py-0.5 text-deck-300 hover:bg-deck-700 disabled:opacity-50"
        >
          {syncing ? 'syncing…' : 'sync now'}
        </button>
      </div>

      {error && <div className="mx-4 mt-3 rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</div>}

      {/* board: columns scroll individually and stop 50px above the bottom (sync pill stays clear) */}
      <main
        className={`flex-1 p-4 ${view === 'board' || view === 'pulls' || view === 'discovery' ? 'overflow-hidden pb-[50px]' : 'overflow-y-auto'}`}
      >
        {view === 'pulls' && (
          <PullRequests
            prs={myPrs}
            me={config.githubUser}
            runs={runs}
            alertedIds={alertedIds}
            onOpen={async (pr) => {
              setPanelTaskId(pr.id)
              await markCardRead(pr.id)
            }}
            onHandleReview={onHandleReview}
            onReorder={reorderMyPr}
          />
        )}
        {view === 'discovery' && (
          <Discovery
            tasks={tasks}
            repos={config.repos}
            onReview={startReview}
            onWatch={(id) => moveStage(id, 'watching')}
            onIgnore={(id) => moveStage(id, 'ignored')}
            onUnignore={(id) => moveStage(id, 'discovered')}
            showIgnored={showIgnored}
            onToggleIgnored={() => setShowIgnored((s) => !s)}
            onSetSeen={markSeen}
            onReorderRepos={reorderRepos}
          />
        )}
        {view === 'board' && (
          <Board
            tasks={tasks}
            runs={runs}
            alertedIds={alertedIds}
            onReorder={async (t, stage, orderedIds) => {
              if (t.stage !== stage) await setStage(t.id, stage)
              await setOrders(orderedIds)
              await reload()
            }}
            onOpenSession={async (t) => {
              setPanelTaskId(t.id)
              await markCardRead(t.id)
              if (t.hasNewActivity) {
                await clearNewActivity(t.id) // clicking a card clears its "new" (same as the 💬 new button)
                await reload()
              }
            }}
            onSeen={async (t) => {
              await clearNewActivity(t.id)
              await reload()
            }}
          />
        )}
        {view === 'settings' && (
          <Settings
            config={config}
            tasks={tasks}
            onSave={saveRepos}
            onSaveReviewButtons={async (buttons) => {
              await setReviewButtons(buttons)
              setConfig(await getConfig())
            }}
            onSavePrButtons={async (buttons) => {
              await setPrButtons(buttons)
              setConfig(await getConfig())
            }}
            onSaveAnimations={async (on) => {
              await setAnimations(on)
              setConfig(await getConfig())
            }}
          />
        )}
      </main>

      {panelTask && (
        <SessionPanel
          task={panelTask}
          run={getRun(panelTask.id)}
          me={config.githubUser}
          myName={config.githubName}
          variant={panelIsPr ? 'pr' : 'review'}
          buttons={visibleButtons(panelIsPr ? config.prButtons : config.reviewButtons, panelTask)}
          onReply={async (text) => {
            const board: ButtonBoard = panelIsPr ? 'pr' : 'review'
            const sessionId = panelTask.sessionIds.at(-1)
            const run = getRun(panelTask.id)
            if (run) replyRun(panelTask.id, text, runCallbacks(board), sessionId)
            // no live run (app restarted, run dismissed): resume the session directly, from the
            // checkout it was started in — `claude --resume` only sees that directory's sessions
            else if (panelTask.repoPath && sessionId) {
              const cwd = await sessionCwd(panelTask.repoPath, sessionId)
              resumeRun(panelTask.id, 'reply', board, cwd, text, sessionId, runCallbacks(board), ACTION_TOOLS)
            }
          }}
          onDismissRun={() => killRun(panelTask.id)}
          onCancel={() => cancelRun(panelTask.id)}
          onRunButton={(button) => runButton(panelTask, panelIsPr ? 'pr' : 'review', button)}
          onStageChange={(stage) => moveStage(panelTask.id, stage)}
          onSnooze={async (snoozed) => {
            await setSnoozed(panelTask.id, snoozed)
            await reload()
          }}
          onKill={() => killRun(panelTask.id)}
          onClose={() => setPanelTaskId(null)}
          onRefresh={(summary) => {
            if (panelIsPr) refreshMyPrFromTimeline(panelTask.id, summary)
            else refreshTaskFromTimeline(panelTask.id, summary.prState)
          }}
        />
      )}
    </div>
  )
}

export default App
