import { exists } from '@tauri-apps/plugin-fs'
import { Command } from '@tauri-apps/plugin-shell'
import type { StreamItem, WatchedRepo } from '../types'
import { ACTION_TOOLS } from './claude'
import {
  addStreamSession,
  allAlerts,
  allMyPrs,
  allTasks,
  claimStreamRun,
  fireStreamWatch,
  logStreamReply,
  saveStreamNext,
  setStreamCheckout,
  streamItem,
  streamItems,
  streamRunEnded,
  streamRunResult,
  watchStreamItem,
} from './db'
import { allowPath } from './fsscope'
import { errText, logError, logInfo } from './log'
import { cancelRun, getRun, getRuns, resumeRun, startRun } from './runs'
import { prRefOf } from './stream'
import { suggestNextStep } from './streamnext'
import { pickNext, STREAM_DENY, STREAM_TOOLS, streamBranch, streamPrompt, worktreeDir } from './streamrun'
import { TRIGGERS, type Trigger, triggerFired, type WaitFor, waitFor, waitingLabel } from './streamwatch'
import { parseWorktrees } from './worktrees'

// Runs Stream items: each in its own worktree, its result waiting for me in Needs you. Module
// level, like runs.ts, so agents keep going while I'm on another tab.

// ── change feed: the Stream view reloads on it, the scheduler ticks on it ──
const listeners = new Set<() => void>()
export const onStreamChange = (cb: () => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export const notifyStream = () => {
  for (const l of listeners) l()
}

export const streamTaskId = (id: string) => `stream:${id}`
export const streamRun = (item: StreamItem) => getRun(streamTaskId(item.id))

const CAPS = { global: 2, perProject: 2 }

const git = async (args: string[], cwd: string) => {
  const out = await Command.create('git', args, { cwd }).execute()
  if (out.code !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr.trim() || `exit ${out.code}`}`)
  return out.stdout.trim()
}

const gitOk = (args: string[], cwd: string) =>
  git(args, cwd).then(
    () => true,
    () => false,
  )

// origin's default branch: origin/HEAD when the clone knows it, else whichever of main/master exists
const defaultBase = async (repoPath: string) => {
  const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath).catch(() => null)
  if (head) return head
  for (const b of ['origin/main', 'origin/master'])
    if (await gitOk(['rev-parse', '--verify', '--quiet', b], repoPath)) return b
  throw new Error('no origin/HEAD, origin/main or origin/master to branch from')
}

// every checkout of the clone, read fresh (worktrees.ts caches for 15 s, too long for "does it exist")
const worktrees = async (repoPath: string) => parseWorktrees(await git(['worktree', 'list', '--porcelain'], repoPath))

// The checkout the agent works in: one worktree per branch, never my own clone. A PR item uses the
// PR's branch (`gh pr checkout` in a fresh worktree handles forks and brings a stale local branch up
// to date); new work gets its own branch off origin's default one. Kept on the item, so a retry or a
// reply lands in the same place.
const prepareCheckout = async (item: StreamItem, repoPath: string): Promise<{ branch: string; checkout: string }> => {
  if (item.checkout && item.branch && item.checkout !== repoPath && (await exists(item.checkout).catch(() => false)))
    return { branch: item.branch, checkout: item.checkout }
  await git(['fetch', 'origin', '--prune'], repoPath).catch(() => null) // offline: work from what we have
  await git(['worktree', 'prune'], repoPath).catch(() => null) // forget worktree dirs deleted by hand
  const pr = item.refKind === 'pr' && item.ref ? prRefOf(item.ref) : null

  if (pr) {
    if (pr.repo !== item.repo) throw new Error(`${item.ref} is not a PR of ${item.repo}`)
    const branch = await prBranch(pr.repo, pr.number, repoPath)
    const list = await worktrees(repoPath)
    if (list.some((w) => w.path === repoPath && w.branch === branch))
      throw new Error(
        `${branch} is checked out in your clone (${repoPath}) — switch it away so the agent gets its own worktree`,
      )
    const existing = list.find((w) => w.branch === branch && w.path !== repoPath)
    if (existing) return { branch, checkout: existing.path }
    const dir = worktreeDir(repoPath, `pr-${pr.number}`)
    if (!list.some((w) => w.path === dir)) await git(['worktree', 'add', '--detach', dir], repoPath)
    await allowPath(dir)
    const out = await Command.create('gh', ['pr', 'checkout', String(pr.number), '--repo', pr.repo], {
      cwd: dir,
    }).execute()
    if (out.code !== 0) throw new Error(`gh pr checkout ${pr.number}: ${out.stderr.trim()}`)
    return { branch, checkout: dir }
  }

  const branch = streamBranch(item.id)
  const dir = worktreeDir(repoPath, branch)
  const list = await worktrees(repoPath)
  const holder = list.find((w) => w.branch === branch)
  if (holder && holder.path !== repoPath) return { branch, checkout: holder.path }
  // a retry after the worktree was cleaned up: the branch (and the agent's commits) is still there
  const branchExists = await gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
  if (branchExists) await git(['worktree', 'add', dir, branch], repoPath)
  else await git(['worktree', 'add', '-b', branch, dir, await defaultBase(repoPath)], repoPath)
  await allowPath(dir)
  return { branch, checkout: dir }
}

const prBranch = async (repo: string, number: number, repoPath: string) => {
  const out = await Command.create(
    'gh',
    ['pr', 'view', String(number), '--repo', repo, '--json', 'headRefName', '-q', '.headRefName'],
    { cwd: repoPath },
  ).execute()
  if (out.code !== 0 || !out.stdout.trim()) throw new Error(`gh pr view ${number}: ${out.stderr.trim()}`)
  return out.stdout.trim()
}

// Items being started right now (worktree prep takes seconds): checked and set synchronously, so a
// double click or a tick racing Run now can't start the same card twice.
const starting = new Set<string>()

// Every dispatch gets a number; a callback from an older one (a process still winding down after a
// reply started the next turn) writes nothing. Writes for one item are chained, so a run's result
// always lands before its exit.
const dispatches = new Map<string, number>()
const queues = new Map<string, Promise<unknown>>()
const serial = (id: string, fn: () => Promise<unknown>) => {
  const next = (queues.get(id) ?? Promise.resolve()).then(fn).catch((e) => logError('stream', e, 'save run state'))
  queues.set(id, next)
  return next.then(notifyStream)
}

const callbacks = (id: string) => {
  const n = (dispatches.get(id) ?? 0) + 1
  dispatches.set(id, n)
  const current = () => dispatches.get(id) === n
  return {
    onSession: (_: string, sessionId: string) => {
      if (current()) serial(id, () => addStreamSession(id, sessionId))
    },
    onResult: (_: string, text: string, isError: boolean) => {
      if (!current()) return
      if (isError) {
        serial(id, () => streamRunEnded(id, 'failed', text || 'claude reported an error'))
        return
      }
      serial(id, () => streamRunResult(id, text || '(the agent finished without a summary)'))
      // Haiku proposes the next step, off the write queue (it takes seconds); saved only if this is
      // still the latest turn
      streamItem(id)
        .then((item) => (item ? suggestNextStep(item, text) : null))
        .then((next) => {
          if (next && current()) serial(id, () => saveStreamNext(id, JSON.stringify(next)))
        })
        .catch((e) => logError('stream', e, 'suggest next step'))
    },
    onEnd: (taskId: string, status: string) => {
      if (!current()) return
      // a result already moved the item on (the write is a no-op then); this catches runs that died
      const last = getRun(taskId)
        ?.lines.filter((l) => l.kind === 'error')
        .at(-1)?.text
      serial(id, () =>
        status === 'error'
          ? streamRunEnded(id, 'failed', last ?? 'claude exited with an error')
          : streamRunEnded(id, 'interrupted', status === 'awaiting-input' ? 'cancelled' : 'ended without a result'),
      )
    },
  }
}

// a checkout another live Stream run is already using (two cards on the same PR)
const busyCheckout = (checkout: string, taskId: string) =>
  getRuns().some((r) => r.taskId !== taskId && r.repoPath === checkout && r.status === 'running')

// Start (or retry) an item's agent. A retry with a session resumes it in the same worktree. The agent
// runs with the Stream tools: local git only, nothing it can push or publish on its own.
export const runStreamItem = async (item: StreamItem, repos: WatchedRepo[], actor: 'me' | 'lookout') => {
  const taskId = streamTaskId(item.id)
  if (starting.has(item.id) || getRun(taskId)?.status === 'running') return
  starting.add(item.id)
  try {
    if (!(await claimStreamRun(item.id, actor === 'me' ? 'started by hand' : 'picked from Queued', actor))) return
    notifyStream()
    const repoPath = repos.find((r) => r.repo === item.repo)?.path
    if (!repoPath) {
      await streamRunEnded(item.id, 'failed', `${item.repo || 'no project'} is not a watched project`)
      return notifyStream()
    }
    let checkout: string
    try {
      const c = await prepareCheckout(item, repoPath)
      checkout = c.checkout
      if (busyCheckout(checkout, taskId)) throw new Error(`another card is already working in ${checkout}`)
      await setStreamCheckout(item.id, c.branch, c.checkout)
      logInfo('stream', `${item.id}: ${c.branch} in ${c.checkout}`)
    } catch (e) {
      await streamRunEnded(item.id, 'failed', `could not prepare a worktree: ${errText(e)}`)
      return notifyStream()
    }
    // a session only resumes where it ran; a new checkout starts over (setStreamCheckout cleared them)
    const session = item.checkout === checkout ? item.sessionIds.at(-1) : undefined
    const cbs = callbacks(item.id)
    // a fired watch says why it woke up; a plain retry just carries on
    const wake = item.waitFor?.resume
    if (session)
      await resumeRun(
        taskId,
        'Stream',
        'stream',
        checkout,
        wake ?? 'Continue where you left off.',
        session,
        cbs,
        STREAM_TOOLS,
        STREAM_DENY,
      )
    else {
      const prompt = wake ? `${streamPrompt(item)}\n\n${wake}` : streamPrompt(item)
      await startRun(taskId, 'Stream', 'stream', prompt, checkout, cbs, STREAM_TOOLS, STREAM_DENY)
    }
  } finally {
    starting.delete(item.id)
  }
}

// My message into the item's session: a note on a result I reject, an answer, "now push it". It is my
// instruction, so it runs with the regular allowlist (push allowed) instead of the Stream one.
export const replyStreamItem = async (item: StreamItem, text: string) => {
  const taskId = streamTaskId(item.id)
  const session = item.sessionIds.at(-1)
  if (!session || !item.checkout) return
  if (starting.has(item.id) || getRun(taskId)?.status === 'running') return
  starting.add(item.id)
  try {
    if (!(await claimStreamRun(item.id, 'resumed with my reply', 'me'))) return
    await logStreamReply(item.id, text)
    notifyStream()
    // always a fresh Run: the previous process may still be exiting, and must not touch this one
    await resumeRun(taskId, 'Stream', 'stream', item.checkout, text, session, callbacks(item.id), ACTION_TOOLS)
  } finally {
    starting.delete(item.id)
  }
}

// Put a card on watch: it waits on its PR instead of on me (Needs you → Active).
export const watchStream = async (item: StreamItem, trigger: Trigger, actor: 'me' | 'lookout', resume?: string) => {
  if (item.refKind !== 'pr' || !item.ref) return
  const w = waitFor(trigger, item.ref, new Date().toISOString(), resume)
  await watchStreamItem(item.id, w, waitingLabel(w), actor)
  notifyStream()
}

// Every watching card against what the sync stored: alerts (author push, review of my PR), CI and
// PR state. A fired card goes back to Queued; Auto-run resumes it. Database reads only.
export const checkWatching = async () => {
  const watching = (await streamItems()).filter((x) => x.status === 'watching' && x.waitFor)
  if (!watching.length) return
  const [alerts, tasks, mine] = await Promise.all([allAlerts(), allTasks(), allMyPrs()])
  let fired = 0
  for (const x of watching) {
    const w = x.waitFor as WaitFor
    const task = tasks.find((t) => t.id === w.ref)
    const pr = mine.find((p) => p.id === w.ref)
    const facts = {
      alerts,
      pr: pr ? { ciState: pr.ciState, state: pr.state } : task ? { ciState: task.ciState, state: task.prState } : null,
    }
    if (!triggerFired(w, facts)) continue
    const what = TRIGGERS.find((t) => t.value === w.trigger)?.label ?? w.trigger
    await fireStreamWatch(x.id, `${what} on #${w.ref.split('#')[1]}`)
    fired++
  }
  if (fired) notifyStream()
}

// App start: a run can't outlive the app, so a card still "running" with no live run was cut short.
// Checked against the live registry, so a hot reload in dev doesn't interrupt a real run.
export const recoverStreamRuns = async () => {
  const stale = (await streamItems()).filter(
    (x) => x.status === 'running' && !starting.has(x.id) && streamRun(x)?.status !== 'running',
  )
  for (const x of stale) await streamRunEnded(x.id, 'interrupted', 'Lookout was closed while the agent ran')
  if (stale.length) notifyStream()
}

export const cancelStreamItem = (item: StreamItem) => cancelRun(streamTaskId(item.id))

// Auto-run: start what Queued has room for. Cheap when idle — one query, no process.
let ticking = false
export const tickStream = async (repos: WatchedRepo[]) => {
  if (ticking) return
  ticking = true
  try {
    for (const item of pickNext(await streamItems(), CAPS)) await runStreamItem(item, repos, 'lookout')
  } catch (e) {
    logError('stream', e, 'scheduler tick')
  } finally {
    ticking = false
  }
}
