import { exists } from '@tauri-apps/plugin-fs'
import { Command } from '@tauri-apps/plugin-shell'
import type { StreamItem, WatchedRepo } from '../types'
import {
  addStreamSession,
  claimStreamRun,
  logStreamReply,
  setStreamCheckout,
  streamItems,
  streamRunEnded,
  streamRunResult,
} from './db'
import { allowPath } from './fsscope'
import { errText, logError, logInfo } from './log'
import { cancelRun, getRun, replyRun, resumeRun, startRun } from './runs'
import { prRefOf } from './stream'
import { pickNext, streamBranch, streamPrompt, worktreeDir } from './streamrun'
import { listWorktrees } from './worktrees'

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

// origin's default branch (origin/main, origin/master…)
const defaultBase = async (repoPath: string) => {
  try {
    return await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath)
  } catch {
    return 'origin/main'
  }
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

// The checkout the agent works in: one worktree per branch. A PR item uses the PR's branch (an
// existing checkout of it, the clone included, before making a new one); new work gets a fresh
// branch off origin's default branch. Kept on the item, so a retry or a reply lands in the same place.
const prepareCheckout = async (item: StreamItem, repoPath: string): Promise<{ branch: string; checkout: string }> => {
  if (item.checkout && item.branch && (await exists(item.checkout).catch(() => false)))
    return { branch: item.branch, checkout: item.checkout }
  await git(['fetch', 'origin', '--prune'], repoPath).catch(() => null) // offline: work from what we have
  const pr = item.refKind === 'pr' && item.ref ? prRefOf(item.ref) : null
  if (pr && pr.repo === item.repo) {
    const branch = await prBranch(pr.repo, pr.number, repoPath)
    const existing = (await listWorktrees(repoPath)).find((w) => w.branch === branch)
    if (existing) return { branch, checkout: existing.path }
    const dir = worktreeDir(repoPath, branch)
    await git(['worktree', 'add', dir, branch], repoPath) // DWIM: tracks origin/<branch>
    await allowPath(dir)
    return { branch, checkout: dir }
  }
  const branch = streamBranch(item.id)
  const dir = worktreeDir(repoPath, branch)
  await git(['worktree', 'add', '-b', branch, dir, await defaultBase(repoPath)], repoPath)
  await allowPath(dir)
  return { branch, checkout: dir }
}

// what the item's run reports back, written to the item as it happens
const callbacks = (id: string) => ({
  onSession: (_: string, sessionId: string) => {
    addStreamSession(id, sessionId)
      .then(notifyStream)
      .catch((e) => logError('stream', e, 'save session'))
  },
  onResult: (_: string, text: string) => {
    streamRunResult(id, text || '(the agent finished without a summary)')
      .then(notifyStream)
      .catch((e) => logError('stream', e, 'save result'))
  },
  onEnd: (taskId: string, status: string) => {
    // a result already moved the item on; this only catches runs that died or were cancelled
    const last = getRun(taskId)
      ?.lines.filter((l) => l.kind === 'error')
      .at(-1)?.text
    const end =
      status === 'error'
        ? streamRunEnded(id, 'failed', last ?? 'claude exited with an error')
        : streamRunEnded(id, 'interrupted', status === 'awaiting-input' ? 'cancelled' : 'ended without a result')
    end.then(notifyStream).catch((e) => logError('stream', e, 'save run end'))
  },
})

// Start (or retry) an item's agent. A retry with a session resumes it in the same worktree.
export const runStreamItem = async (item: StreamItem, repos: WatchedRepo[], actor: 'me' | 'lookout') => {
  const taskId = streamTaskId(item.id)
  if (getRun(taskId)?.status === 'running') return
  const repoPath = repos.find((r) => r.repo === item.repo)?.path
  await claimStreamRun(item.id, actor === 'me' ? 'started by hand' : 'picked from Queued', actor)
  notifyStream()
  if (!repoPath) {
    await streamRunEnded(item.id, 'failed', `${item.repo || 'no project'} is not a watched project`)
    return notifyStream()
  }
  let checkout: string
  try {
    const c = await prepareCheckout(item, repoPath)
    checkout = c.checkout
    await setStreamCheckout(item.id, c.branch, c.checkout)
    logInfo('stream', `${item.id}: ${c.branch} in ${c.checkout}`)
  } catch (e) {
    await streamRunEnded(item.id, 'failed', `could not prepare a worktree: ${errText(e)}`)
    return notifyStream()
  }
  const session = item.sessionIds.at(-1)
  if (session && item.checkout === checkout)
    await resumeRun(taskId, 'Stream', 'stream', checkout, 'Continue where you left off.', session, callbacks(item.id))
  else await startRun(taskId, 'Stream', 'stream', streamPrompt(item), checkout, callbacks(item.id))
}

// My message into the item's session: a note on a result I reject, an answer, "now push it".
export const replyStreamItem = async (item: StreamItem, text: string) => {
  const taskId = streamTaskId(item.id)
  const session = item.sessionIds.at(-1)
  if (!session || !item.checkout) return
  await logStreamReply(item.id, text)
  await claimStreamRun(item.id, 'resumed with my reply', 'me')
  notifyStream()
  if (getRun(taskId)) await replyRun(taskId, text, callbacks(item.id), session)
  else await resumeRun(taskId, 'Stream', 'stream', item.checkout, text, session, callbacks(item.id))
}

// App start: a run can't outlive the app, so a card still "running" with no live run was cut short.
// Checked against the live registry, so a hot reload in dev doesn't interrupt a real run.
export const recoverStreamRuns = async () => {
  const stale = (await streamItems()).filter((x) => x.status === 'running' && streamRun(x)?.status !== 'running')
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
