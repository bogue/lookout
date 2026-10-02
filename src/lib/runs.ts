import type { Child } from '@tauri-apps/plugin-shell'
import type { ButtonBoard } from '../types'
import { REVIEW_TOOLS, spawnClaude } from './claude'
import { errText, logError, logInfo, logWarn } from './log'

// which board a run belongs to: a PR board's action button, or a Stream item's agent
export type RunBoard = ButtonBoard | 'stream'

export type RunLine = { kind: 'text' | 'tool' | 'user' | 'error'; text: string }

export type Run = {
  taskId: string
  command: string // the button label that started the run (display only)
  board: RunBoard // routes post-run behavior (review vs my-PR board, or a Stream item)
  repoPath: string
  sessionId: string | null
  lines: RunLine[]
  status: 'running' | 'awaiting-input' | 'error' | 'closed'
  child: Child | null
  allowedTools: string // tool allowlist for this run's command (reused on reply/resume)
  disallowedTools?: string // denied even when my own settings allow them (Stream: no push, no merge)
  // Bumped on every dispatch. A reply starts a new process on the same Run while the previous one
  // may still be shutting down; its late events (exit above all) carry the old number and are dropped,
  // or they would mark the new turn closed and drop its child handle.
  gen: number
}

// Module-level registry so runs survive view switches; React subscribes via listeners.
const runs = new Map<string, Run>()
const listeners = new Set<() => void>()
let snapshot: Run[] = []

const notify = () => {
  snapshot = [...runs.values()]
  for (const l of listeners) l()
}

export const subscribeRuns = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export const getRuns = () => snapshot

export const getRun = (taskId: string) => runs.get(taskId)

type Callbacks = {
  onSession?: (taskId: string, sessionId: string) => void
  onResult?: (taskId: string, resultText: string, isError: boolean) => void
  // the process is gone (or never started): the run's final status says how it went
  onEnd?: (taskId: string, status: Run['status']) => void
}

const dispatch = async (run: Run, prompt: string, callbacks: Callbacks, resumeSessionId?: string) => {
  run.gen += 1
  const gen = run.gen
  run.status = 'running'
  notify()
  logInfo('run', `${run.taskId}: ${run.command} in ${run.repoPath}${resumeSessionId ? ' (resume)' : ''}`)
  try {
    run.child = await spawnClaude(
      prompt,
      run.repoPath,
      (e) => {
        if (gen !== run.gen) return // a previous turn's process, still winding down
        if (e.type === 'init') {
          run.sessionId = e.sessionId
          callbacks.onSession?.(run.taskId, e.sessionId)
        } else if (e.type === 'text') run.lines.push({ kind: 'text', text: e.text })
        else if (e.type === 'tool') run.lines.push({ kind: 'tool', text: `${e.name} ${e.detail}`.trim() })
        else if (e.type === 'stderr') {
          run.lines.push({ kind: 'error', text: e.text })
          logWarn('run', `${run.taskId}: ${e.text}`)
        } else if (e.type === 'result') {
          run.status = 'awaiting-input'
          // the final summary usually duplicates the last text block — only push when it doesn't
          if (e.text && run.lines.at(-1)?.text !== e.text) run.lines.push({ kind: 'text', text: e.text })
          callbacks.onResult?.(run.taskId, e.text, e.isError)
        } else if (e.type === 'exit') {
          run.child = null
          if (run.status === 'running') run.status = e.code === 0 ? 'closed' : 'error'
          if (e.code !== 0) logWarn('run', `${run.taskId}: claude exited with code ${e.code}`)
          callbacks.onEnd?.(run.taskId, run.status)
        }
        notify()
      },
      resumeSessionId,
      run.allowedTools,
      run.disallowedTools,
    )
  } catch (e) {
    // claude never started (missing from PATH, cwd gone, denied by the shell scope). Without this the
    // promise rejected into nothing and the card sat on "running" forever with an empty transcript.
    run.status = 'error'
    run.lines.push({ kind: 'error', text: `could not start claude: ${errText(e)}` })
    logError('run', e, `${run.taskId}: spawn claude in ${run.repoPath}`)
    callbacks.onEnd?.(run.taskId, run.status)
  }
  notify()
}

export const startRun = async (
  taskId: string,
  command: Run['command'],
  board: RunBoard,
  prompt: string,
  repoPath: string,
  callbacks: Callbacks = {},
  allowedTools: string = REVIEW_TOOLS,
  disallowedTools?: string,
) => {
  const existing = runs.get(taskId)
  if (existing && existing.status === 'running') return
  const run: Run = {
    taskId,
    command,
    board,
    repoPath,
    sessionId: null,
    lines: [{ kind: 'user', text: prompt }],
    status: 'running',
    child: null,
    allowedTools,
    disallowedTools,
    gen: 0,
  }
  runs.set(taskId, run)
  await dispatch(run, prompt, callbacks)
}

export const replyRun = async (taskId: string, text: string, callbacks: Callbacks = {}, fallbackSessionId?: string) => {
  const run = runs.get(taskId)
  if (!run || run.status === 'running') return
  const sessionId = run.sessionId ?? fallbackSessionId
  if (!sessionId) return
  run.sessionId = sessionId
  run.lines.push({ kind: 'user', text })
  await dispatch(run, text, callbacks, sessionId)
}

// Reply into a past session with no live run (e.g. after app restart): recreate the run and resume
export const resumeRun = async (
  taskId: string,
  command: Run['command'],
  board: RunBoard,
  repoPath: string,
  text: string,
  sessionId: string,
  callbacks: Callbacks = {},
  allowedTools: string = REVIEW_TOOLS,
  disallowedTools?: string,
) => {
  const existing = runs.get(taskId)
  if (existing && existing.status === 'running') return
  const run: Run = {
    taskId,
    command,
    board,
    repoPath,
    sessionId,
    lines: [{ kind: 'user', text }],
    status: 'running',
    child: null,
    allowedTools,
    disallowedTools,
    gen: 0,
  }
  runs.set(taskId, run)
  await dispatch(run, text, callbacks, sessionId)
}

// A run that failed before claude could start (its checkout couldn't be set up): shown in the panel
// like any failed run, with what was typed, instead of the message vanishing
export const failRun = (
  taskId: string,
  command: Run['command'],
  board: RunBoard,
  repoPath: string,
  text: string,
  error: unknown,
) => {
  runs.set(taskId, {
    taskId,
    command,
    board,
    repoPath,
    sessionId: null,
    lines: [
      { kind: 'user', text },
      { kind: 'error', text: `could not start claude: ${errText(error)}` },
    ],
    status: 'error',
    child: null,
    allowedTools: REVIEW_TOOLS,
    gen: 0,
  })
  notify()
}

// Mark a finished run as closed (no further input expected)
export const closeRun = (taskId: string) => {
  const run = runs.get(taskId)
  if (run && run.status !== 'running') {
    run.status = 'closed'
    notify()
  }
}

// Abort the in-flight turn but keep the run + session resumable (misclick -> cancel -> resend)
export const cancelRun = async (taskId: string) => {
  const run = runs.get(taskId)
  if (run?.status !== 'running') return
  run.status = 'awaiting-input' // before kill: the exit handler leaves non-running statuses alone
  run.lines.push({ kind: 'error', text: '■ cancelled — session still resumable' })
  if (run.child) await run.child.kill()
  run.child = null
  notify()
}

export const killRun = async (taskId: string) => {
  const run = runs.get(taskId)
  if (run?.child) await run.child.kill()
  runs.delete(taskId)
  notify()
}
