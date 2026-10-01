import { homeDir } from '@tauri-apps/api/path'
import { exists } from '@tauri-apps/plugin-fs'
import { Command } from '@tauri-apps/plugin-shell'
import type { StreamItem, WatchedRepo } from '../types'
import { ACTION_TOOLS } from './claude'
import { getWatcherRuns, setWatcherRun } from './config'
import {
  addStreamItems,
  addStreamSession,
  advanceStreamStep,
  allMyPrs,
  allowRiskyStreamItem,
  allTasks,
  armStreamWatch,
  claimStreamRun,
  clearStreamSessions,
  finishShaping,
  fireStreamWatch,
  logStreamReply,
  logStreamSent,
  markStreamStarted,
  saveStreamNext,
  setStreamCheckout,
  setStreamPriority,
  setStreamStatus,
  streamEvents,
  streamItem,
  streamItems,
  streamRiskVerdict,
  streamRunEnded,
  streamRunResult,
  streamShapeResult,
  unwatchStreamItem,
  watchAlerts,
  watcherCards,
  watchStreamItem,
} from './db'
import { allowPath } from './fsscope'
import { errText, logError, logInfo } from './log'
import { cancelRun, getRun, getRuns, resumeRun, startRun } from './runs'
import { prRefOf } from './stream'
import { advance, type FlowTemplate, fillStep } from './streamflow'
import { suggestNextStep } from './streamnext'
import { localPriority, needsRating, ratePriorities } from './streampriority'
import { assessRisk, needsRiskCheck } from './streamrisk'
import { pickNext, STREAM_DENY, STREAM_TOOLS, streamBranch, streamPrompt, unanswered, worktreeDir } from './streamrun'
import { type Proposal, parseProposal, SHAPE_DENY, SHAPE_TOOLS, shapePrompt } from './streamshape'
import { alertAt, checkTrigger, TRIGGERS, type Trigger, type WaitFor, waitFor, waitingLabel } from './streamwatch'
import {
  DEFAULT_TASK,
  dueWatchers,
  type Match,
  matchesOf,
  parseWatcherCards,
  type Watcher,
  type WatcherCheck,
  type WatchFacts,
  watcherKey,
  watcherPrompt,
} from './streamwatchers'
import { timeAgo } from './time'
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

// the checkout marker of a shaping card: it runs read-only in my clone, never in a worktree
export const SHAPE_BRANCH = 'read-only'

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
  if (
    item.checkout &&
    item.branch &&
    item.branch !== SHAPE_BRANCH &&
    item.checkout !== repoPath &&
    (await exists(item.checkout).catch(() => false))
  )
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

// Shaping reads the project from a detached worktree of its own, never from my clone: the agent is
// denied every write it could name, but my own Claude settings merge in, and a stray `git stash` or
// `git switch` there would land on throwaway files instead of my work.
const shapeCheckout = async (item: StreamItem, repoPath: string): Promise<string> => {
  const dir = worktreeDir(repoPath, `shape-${item.id.slice(0, 8)}`)
  if (item.checkout === dir && (await exists(dir).catch(() => false))) return dir
  await git(['fetch', 'origin', '--prune'], repoPath).catch(() => null)
  await git(['worktree', 'prune'], repoPath).catch(() => null)
  if (!(await worktrees(repoPath)).some((w) => w.path === dir))
    await git(['worktree', 'add', '--detach', dir, await defaultBase(repoPath)], repoPath)
  await allowPath(dir)
  return dir
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

// mode: a work turn (result → review, Haiku's next step) or a shaping turn (questions or a proposal)
const callbacks = (id: string, mode: 'work' | 'shape' = 'work') => {
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
      if (mode === 'shape') {
        const proposal = parseProposal(text)
        serial(id, () => streamShapeResult(id, text, proposal ? JSON.stringify(proposal) : null))
        return
      }
      serial(id, () => streamRunResult(id, text || '(the agent finished without a summary)'))
      // A flow step with no gate moves on by itself. Otherwise Haiku proposes the next step, off the
      // write queue (it takes seconds); saved only if this is still the latest turn.
      // (serial: read the card once the result above is written)
      serial(id, async () => undefined)
        .then(() => streamItem(id))
        .then(async (item) => {
          const step = item?.steps[item.stepIndex]
          if (current() && item?.status === 'needs_review' && step && !step.gate) {
            await approveStreamItem(item, 'lookout')
            return null
          }
          return item ? suggestNextStep(item, text) : null
        })
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

// a failed or cut-short turn: what it was sent never got an answer, and a retry sends it again
const unansweredOf = async (item: StreamItem) =>
  item.status === 'failed' || item.status === 'interrupted' ? unanswered(await streamEvents(item.id)) : null

// starting over in a new session still carries what never got an answer
const withLost = (prompt: string, lost: string | null) =>
  lost && !prompt.includes(lost) ? `${prompt}\n\nMy last message to you, which never got an answer:\n${lost}` : prompt

// Start (or retry) an item's agent. A retry resumes the same session in the same worktree and sends
// again what the dead turn never answered; `fresh` starts a new session instead. The agent runs with
// the Stream tools: local git only, nothing it can push or publish on its own.
export const runStreamItem = async (
  item: StreamItem,
  repos: WatchedRepo[],
  actor: 'me' | 'lookout',
  opts: { fresh?: boolean } = {},
) => {
  const taskId = streamTaskId(item.id)
  if (starting.has(item.id) || getRun(taskId)?.status === 'running') return
  // A flow step that waits on GitHub first (the first step included): watch before running it.
  // `step-now` is my Stop watching — go without waiting; a stored watch means it already fired.
  const pending = item.steps[item.stepIndex]
  const stepNotStarted = item.gate === 'step' || (item.stepIndex === 0 && !item.sessionIds.length)
  if (pending?.waitFor && stepNotStarted && item.gate !== 'step-now' && !item.waitFor && item.refKind === 'pr')
    return watchStream(item, pending.waitFor, actor, stepText(item, item.stepIndex), 'step')
  starting.add(item.id)
  try {
    const lost = await unansweredOf(item)
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
    if (opts.fresh) await clearStreamSessions(item.id)
    // a session only resumes where it ran; a new checkout starts over (setStreamCheckout cleared them)
    const session = !opts.fresh && item.checkout === checkout ? item.sessionIds.at(-1) : undefined
    const cbs = callbacks(item.id)
    // a fired watch says why it woke up, a flow's next step what to do now, a retry what was lost
    const step = item.steps.length ? stepText(item, item.stepIndex) : null
    const freshStep = item.gate === 'step' || item.gate === 'step-now'
    const wake = item.waitFor?.resume ?? (freshStep ? (step ?? undefined) : undefined)
    if (session) {
      const input = wake ?? lost ?? 'Continue where you left off.'
      await logStreamSent(item.id, input)
      await resumeRun(taskId, 'Stream', 'stream', checkout, input, session, cbs, STREAM_TOOLS, STREAM_DENY)
    } else {
      const first = wake ?? step
      const prompt = withLost(first ? `${streamPrompt(item)}\n\n${first}` : streamPrompt(item), lost)
      await logStreamSent(item.id, prompt)
      await startRun(taskId, 'Stream', 'stream', prompt, checkout, cbs, STREAM_TOOLS, STREAM_DENY)
    }
    await markStreamStarted(item.id) // the step's prompt went out: its gate and watch are spent
  } finally {
    starting.delete(item.id)
  }
}

// My message into the item's session: a note on a result I reject, an answer, "now push it". It is my
// instruction, so it runs with the regular allowlist (push allowed) instead of the Stream one.
// False when it could not go out (no session to resume, or the agent is still running): the caller
// keeps my text, nothing typed is lost.
export const replyStreamItem = async (item: StreamItem, text: string): Promise<boolean> => {
  const taskId = streamTaskId(item.id)
  const session = item.sessionIds.at(-1)
  if (!session || !item.checkout) return false
  if (starting.has(item.id) || getRun(taskId)?.status === 'running') return false
  starting.add(item.id)
  try {
    // a shaping conversation stays read-only, whoever speaks — keyed on its checkout marker (set by
    // shapeStreamItem, replaced only when real work prepares a worktree), so a failed turn can't
    // turn a reply into an editing run
    const shaping = item.branch === SHAPE_BRANCH
    if (!(await claimStreamRun(item.id, 'resumed with my reply', 'me'))) return false
    await logStreamReply(item.id, text)
    notifyStream()
    // a flow step not started yet goes along with my reply, or it would never be sent
    const stepFirst =
      (item.gate === 'step' || item.gate === 'step-now') && item.steps[item.stepIndex]
        ? `${stepText(item, item.stepIndex)}\n\n${text}`
        : text
    // always a fresh Run: the previous process may still be exiting, and must not touch this one
    if (shaping)
      await resumeRun(
        taskId,
        'Shape',
        'stream',
        item.checkout,
        text,
        session,
        callbacks(item.id, 'shape'),
        SHAPE_TOOLS,
        SHAPE_DENY,
      )
    else
      await resumeRun(taskId, 'Stream', 'stream', item.checkout, stepFirst, session, callbacks(item.id), ACTION_TOOLS)
    await markStreamStarted(item.id)
    return true
  } finally {
    starting.delete(item.id)
  }
}

// Shape an Inbox idea: a read-only agent in a throwaway worktree of the project (shapeCheckout) asks
// what it needs and proposes the cards. Its conversation is the item's thread. A retry resumes that
// conversation with what never got an answer; `fresh` starts it over (carrying that message along).
export const shapeStreamItem = async (item: StreamItem, repos: WatchedRepo[], opts: { fresh?: boolean } = {}) => {
  const taskId = streamTaskId(item.id)
  const repoPath = repos.find((r) => r.repo === item.repo)?.path
  if (!repoPath || starting.has(item.id) || getRun(taskId)?.status === 'running') return
  starting.add(item.id)
  try {
    const lost = await unansweredOf(item)
    if (!(await claimStreamRun(item.id, 'shaping with a read-only agent', 'me'))) return
    notifyStream()
    let dir: string
    try {
      dir = await shapeCheckout(item, repoPath)
    } catch (e) {
      await streamRunEnded(item.id, 'failed', `could not prepare a read-only worktree: ${errText(e)}`)
      return notifyStream()
    }
    await setStreamCheckout(item.id, SHAPE_BRANCH, dir) // a new dir clears the sessions
    if (opts.fresh) await clearStreamSessions(item.id)
    const session = !opts.fresh && item.checkout === dir ? item.sessionIds.at(-1) : undefined
    const cbs = callbacks(item.id, 'shape')
    if (session) {
      const input = lost ?? 'Continue where you left off.'
      await logStreamSent(item.id, input)
      await resumeRun(taskId, 'Shape', 'stream', dir, input, session, cbs, SHAPE_TOOLS, SHAPE_DENY)
    } else {
      const prompt = withLost(shapePrompt(item), lost)
      await logStreamSent(item.id, prompt)
      await startRun(taskId, 'Shape', 'stream', prompt, dir, cbs, SHAPE_TOOLS, SHAPE_DENY)
    }
    await markStreamStarted(item.id)
  } finally {
    starting.delete(item.id)
  }
}

// Take a proposal: its cards join the board in the same project and reference, the idea is done
export const acceptProposal = async (item: StreamItem, proposal: Proposal, queue: boolean) => {
  // finish first, guarded: a second click finds the idea done and creates nothing
  if (!(await finishShaping(item.id, proposal.cards.length))) return
  await addStreamItems(
    proposal.cards.map((c) => ({
      title: c.title,
      body: c.notes,
      repo: item.repo,
      refKind: item.refKind,
      ref: item.ref,
    })),
    queue ? 'queued' : 'idea',
    `shaped from “${item.title}”`,
  )
  notifyStream()
}

// statuses where a card waits on me, the only ones an approval can move
const WAITS_ON_ME: StreamItem['status'][] = ['needs_review', 'question', 'failed', 'interrupted']

// a flow step as the agent reads it: where it is, and what to do
const stepText = (item: StreamItem, index: number) =>
  `Step ${index + 1} of ${item.steps.length}: ${fillStep(item.steps[index], item, item.guidelines)}`

// Approve the card's current result. A flow moves to its next step — queued, or watching GitHub
// first when that step says so — and only the last step's approval finishes the card.
export const approveStreamItem = async (snapshot: StreamItem, actor: 'me' | 'lookout') => {
  // the card as it is now: a double click, or a run Auto-run started meanwhile, must not advance it
  const item = await streamItem(snapshot.id)
  if (!item || item.stepIndex !== snapshot.stepIndex || !WAITS_ON_ME.includes(item.status)) return
  // a risky card waiting for my OK: approving lets it start, it has no result to move past
  if (item.gate === 'risk') {
    await allowRiskyStreamItem(item.id)
    return notifyStream()
  }
  const next = advance(item.steps, item.stepIndex)
  if (next.kind === 'done') {
    await setStreamStatus(item, 'done')
    return notifyStream()
  }
  const label = `step ${next.index + 1} of ${item.steps.length}`
  const text = stepText(item, next.index)
  const w =
    next.waitFor && item.refKind === 'pr' && item.ref
      ? waitFor(next.waitFor, item.ref, new Date().toISOString(), text, await armedAtStart(next.waitFor, item.ref))
      : null
  const moved = await advanceStreamStep(
    item.id,
    item.stepIndex,
    next.index,
    w ? `${label} — ${waitingLabel(w)}` : `${label} queued`,
    w,
  )
  if (!moved) return
  logInfo('stream', `${item.id}: ${actor} → ${label}`)
  notifyStream()
}

// Put a card on watch: it waits on its PR instead of on me (Needs you → Active).
// gate 'step': a flow waiting before a step (resume = that step), so Stop watching runs the step
export const watchStream = async (
  item: StreamItem,
  trigger: Trigger,
  actor: 'me' | 'lookout',
  resume?: string,
  gate: 'step' | null = null,
) => {
  if (item.refKind !== 'pr' || !item.ref) return
  const w = waitFor(trigger, item.ref, new Date().toISOString(), resume, await armedAtStart(trigger, item.ref))
  await watchStreamItem(item.id, w, waitingLabel(w), actor, gate)
  notifyStream()
}

export const unwatchStream = async (item: StreamItem) => {
  await unwatchStreamItem(item)
  notifyStream()
}

// what the sync stored about a PR, from whichever board holds it
const prFacts = async () => {
  const [tasks, mine] = await Promise.all([allTasks(), allMyPrs()])
  return (ref: string) => {
    const pr = mine.find((p) => p.id === ref)
    if (pr) return { ciState: pr.ciState, state: pr.state }
    const task = tasks.find((t) => t.id === ref)
    return task ? { ciState: task.ciState, state: task.prState } : null
  }
}

// A green CI stored when the watch begins is the previous commit's: such a watch waits for CI to
// leave green first (armed: false). Any other trigger, or a CI not green yet, starts armed.
const armedAtStart = async (trigger: Trigger, ref: string) =>
  trigger !== 'ci_green' || (await prFacts())(ref)?.ciState !== 'pass'

// Every watching card against what the sync stored: alerts (author push, review of my PR), CI and
// PR state. A fired card goes back to Queued; Auto-run resumes it. Database reads only.
export const checkWatching = async () => {
  const watching = (await streamItems()).filter((x) => x.status === 'watching' && x.waitFor)
  if (!watching.length) return
  const [rows, prOf] = await Promise.all([watchAlerts(), prFacts()])
  const alerts = rows.map((a) => ({
    kind: a.kind,
    taskId: a.taskId,
    at: alertAt(a.key, a.kind, a.taskId, a.createdAt),
  }))
  let fired = 0
  for (const x of watching) {
    const w = x.waitFor as WaitFor
    const verdict = checkTrigger(w, { alerts, pr: prOf(w.ref) })
    if (verdict === 'arm') await armStreamWatch(x.id, w)
    if (verdict !== 'fire') continue
    const what = TRIGGERS.find((t) => t.value === w.trigger)?.label ?? w.trigger
    await fireStreamWatch(x.id, `${what} on #${w.ref.split('#')[1]}`)
    fired++
  }
  if (fired) notifyStream()
}

// Needs you criticality: every card that reached it unrated gets one — local rules first, then one
// Haiku call for the rest. Each card is rated once per visit (claimStreamRun clears Haiku's rating
// when it leaves); mine is never touched.
const rating = new Set<string>()
const WAITS_ON: Partial<Record<StreamItem['status'], string>> = {
  needs_review: 'my review of its result',
  question: 'my answer to its question',
  failed: 'a look at a failed run',
  interrupted: 'a retry after an interruption',
}
export const rateWaiting = async (items: StreamItem[]) => {
  const todo = items.filter((x) => needsRating(x) && !rating.has(x.id))
  if (!todo.length) return
  for (const x of todo) rating.add(x.id)
  try {
    const ask: StreamItem[] = []
    for (const x of todo) {
      const local = localPriority(x)
      if (local) await setStreamPriority(x.id, local.priority, local.reason, 'haiku')
      else ask.push(x)
    }
    const cards = await Promise.all(
      ask.map(async (x) => {
        const said = (await streamEvents(x.id)).filter((e) => e.kind === 'result' || e.kind === 'question').at(-1)
        return {
          title: x.title,
          waitsOn: WAITS_ON[x.status] ?? x.status,
          excerpt: said?.text ?? '',
          waiting: timeAgo(x.updatedAt),
        }
      }),
    )
    const ratings = await ratePriorities(cards)
    for (const [i, x] of ask.entries()) await setStreamPriority(x.id, ratings[i].priority, ratings[i].reason, 'haiku')
    notifyStream()
  } catch (e) {
    logError('stream', e, 'rate needs you')
  } finally {
    for (const x of todo) rating.delete(x.id)
  }
}

// Watchers: each due one turns what it finds into Queued cards (the risk check then decides whether
// they start without me). A structured one reads what the sync stored; a prompt one asks a read-only
// agent. An event (or a prompt card's key) becomes a card once; a PR with a live card from the same
// watcher gets no second one until that one is done or skipped. Each run is recorded — when, how
// many cards, what failed — for the watchers panel.
const runningWatchers = new Set<string>()

const cardsOf = (w: Watcher, matches: Match[], template: FlowTemplate | undefined) =>
  matches.map((m) => ({
    title: template ? `${m.title} (#${m.number})` : DEFAULT_TASK[w.check as Exclude<WatcherCheck, 'prompt'>](m.number),
    repo: m.repo,
    refKind: 'pr' as const,
    ref: m.ref,
    createdBy: `watcher:${w.id}`,
    dedupeKey: watcherKey(w, m),
    gate: template ? 'step-now' : undefined, // the event it waited for already happened
  }))

// a prompt watcher: a read-only agent checks what I asked, outside my repos, and answers with cards
const promptCards = async (w: Watcher, known: { key: string; title: string }[], template: FlowTemplate | undefined) => {
  const tools = [SHAPE_TOOLS, ...w.tools.split(',').map((t) => t.trim())].filter(Boolean).join(',')
  const out = await Command.create(
    'claude',
    [
      '-p',
      watcherPrompt(w, known),
      ...(w.model === 'default' ? [] : ['--model', w.model]),
      '--allowedTools',
      tools,
      '--disallowedTools',
      SHAPE_DENY,
      '--no-session-persistence', // a check, not a conversation: no transcript left behind
    ],
    { cwd: await homeDir() },
  ).execute()
  if (out.code !== 0) throw new Error(out.stderr.trim() || `claude exited ${out.code}`)
  return parseWatcherCards(out.stdout, w.repo).map((c) => ({
    title: c.title,
    body: c.notes,
    repo: c.repo,
    refKind: c.ref ? ('pr' as const) : null,
    ref: c.ref,
    createdBy: `watcher:${w.id}`,
    dedupeKey: `${w.id}|${c.key}`,
    gate: template ? 'step-now' : undefined,
  }))
}

const runWatcher = async (
  w: Watcher,
  template: FlowTemplate | undefined,
  facts: WatchFacts,
  cards: { key: string; title: string; live: boolean }[],
) => {
  let fresh: Parameters<typeof addStreamItems>[0]
  if (w.check === 'prompt') {
    const mine = cards.filter((c) => c.key.startsWith(`${w.id}|`))
    const known = mine.slice(-30).map((c) => ({ key: c.key.slice(w.id.length + 1), title: c.title }))
    fresh = (await promptCards(w, known, template)).filter((c) => !cards.some((k) => k.key === c.dedupeKey))
  } else {
    const matches = matchesOf(w, facts).filter((m) => {
      const key = watcherKey(w, m)
      const prefix = `${w.id}|${m.ref}|`
      return !cards.some((c) => c.key === key || (c.live && c.key.startsWith(prefix)))
    })
    fresh = cardsOf(w, matches, template)
  }
  if (fresh.length) await addStreamItems(fresh, 'queued', `by watcher “${w.name}”`, template)
  return fresh.length
}

export const runWatchers = async (watchers: Watcher[], templates: FlowTemplate[]) => {
  const runs = await getWatcherRuns()
  const due = dueWatchers(
    watchers.filter((w) => !runningWatchers.has(w.id)),
    Object.fromEntries(Object.entries(runs).map(([id, r]) => [id, r.at])),
  )
  if (!due.length) return
  for (const w of due) runningWatchers.add(w.id)
  try {
    const [tasks, myPrs, alerts, cards] = await Promise.all([allTasks(), allMyPrs(), watchAlerts(), watcherCards()])
    const facts = { tasks, myPrs, alerts }
    // prompt watchers take seconds to minutes: they run side by side, each recording its own outcome
    await Promise.all(
      due.map(async (w) => {
        const at = new Date().toISOString()
        try {
          const made = await runWatcher(
            w,
            templates.find((t) => t.id === w.templateId),
            facts,
            cards,
          )
          await setWatcherRun(w.id, { at, made })
          if (made) {
            logInfo('stream', `watcher ${w.name}: ${made} card${made === 1 ? '' : 's'}`)
            notifyStream()
          }
        } catch (e) {
          logError('stream', e, `watcher ${w.name}`)
          await setWatcherRun(w.id, { at, made: 0, error: errText(e).slice(0, 300) })
        }
      }),
    )
  } finally {
    for (const w of due) runningWatchers.delete(w.id)
    notifyStream() // the watchers panel shows each last run
  }
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
    for (const item of pickNext(await streamItems(), CAPS)) {
      // a card's first start without me passes the risk check; a risky one waits for my OK instead
      if (needsRiskCheck(item)) {
        const risk = await assessRisk(item)
        if (!(await streamRiskVerdict(item.id, risk.risky, risk.reason)) || risk.risky) {
          notifyStream()
          continue
        }
      }
      await runStreamItem(item, repos, 'lookout')
    }
  } catch (e) {
    logError('stream', e, 'scheduler tick')
  } finally {
    ticking = false
  }
}
