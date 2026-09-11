import { homeDir, join } from '@tauri-apps/api/path'
import { exists, readDir, readTextFileLines } from '@tauri-apps/plugin-fs'
import { listWorktrees } from './worktrees'

export type ReviewSession = {
  sessionId: string
  command: string | null // slash command that opened the session, when it started with one
  branch: string
  ts: string | null
  cwd: string // checkout the session ran in — the clone or one of its worktrees
}

// /Users/x/Projects/@foo/bar -> -Users-x-Projects--foo-bar (Claude Code project slug)
const projectSlug = (repoPath: string) => repoPath.replace(/[^a-zA-Z0-9]/g, '-')

const sessionDir = async (checkout: string) => join(await homeDir(), '.claude', 'projects', projectSlug(checkout))

const REVIEW_COMMAND_RE = /<command-name>\/?(do-review|do-followup)<\/command-name>(?:\\n|\s)*<command-args>([^<"]*)/
const ANY_COMMAND_RE = /<command-name>\/?([\w-]+)<\/command-name>/
const TS_RE = /"timestamp":"([^"]+)"/

// Cache: session files are append-only; once a file's first turn is parsed the result never changes.
const cache = new Map<string, ReviewSession | null>()

// `worktreeBranch` is set for a worktree checkout: a worktree is dedicated to one branch, so every
// session in it belongs to that branch whatever command opened it. The clone hosts sessions for many
// branches over time, so there the branch can only come from the command's own argument.
const scanFile = async (
  filePath: string,
  sessionId: string,
  cwd: string,
  worktreeBranch: string | null,
): Promise<ReviewSession | null> => {
  if (cache.has(filePath)) return cache.get(filePath) ?? null
  let result: ReviewSession | null = null
  let command: string | null = null
  let ts: string | null = null
  const lines = await readTextFileLines(filePath)
  let count = 0
  for await (const line of lines) {
    ts ??= line.match(TS_RE)?.[1] ?? null
    const review = line.match(REVIEW_COMMAND_RE)
    if (review) {
      command = review[1]
      const branch = review[2].trim()
      if (branch) result = { sessionId, command, branch, ts, cwd }
      break
    }
    const any = line.match(ANY_COMMAND_RE)
    if (any) {
      command = any[1]
      break
    }
    if (++count >= 20) break
  }
  if (!result && worktreeBranch) result = { sessionId, command, branch: worktreeBranch, ts, cwd }
  cache.set(filePath, result)
  return result
}

const scanCheckout = async (cwd: string, worktreeBranch: string | null): Promise<ReviewSession[]> => {
  const sessions: ReviewSession[] = []
  const dir = await sessionDir(cwd)
  if (!(await exists(dir))) return sessions
  const entries = await readDir(dir)
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue
    const sessionId = entry.name.replace(/\.jsonl$/, '')
    try {
      const session = await scanFile(await join(dir, entry.name), sessionId, cwd, worktreeBranch)
      if (session) sessions.push(session)
    } catch {
      // unreadable session file: skip
    }
  }
  return sessions
}

// Sessions across every checkout of the repo: work moved into a worktree is still this repo's work.
// Sorted oldest first — callers resume `sessionIds.at(-1)` as "the session I was just in".
const scanRepo = async (repoPath: string): Promise<ReviewSession[]> => {
  const sessions: ReviewSession[] = []
  for (const w of await listWorktrees(repoPath))
    sessions.push(...(await scanCheckout(w.path, w.path === repoPath ? null : w.branch)))
  return sessions.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''))
}

// Map branch -> session ids for a repo
export const scanRepoSessions = async (repoPath: string): Promise<Map<string, string[]>> => {
  const byBranch = new Map<string, string[]>()
  for (const s of await scanRepo(repoPath)) {
    const ids = byBranch.get(s.branch) ?? []
    ids.push(s.sessionId)
    byBranch.set(s.branch, ids)
  }
  return byBranch
}

export const sessionsForBranch = async (repoPath: string, branch: string): Promise<ReviewSession[]> =>
  (await scanRepo(repoPath)).filter((s) => s.branch === branch)

// Which checkout a session can be resumed from: `claude --resume` only sees the sessions of the
// directory it runs in, so resuming a worktree session from the clone would fail to find it.
export const sessionCwd = async (repoPath: string, sessionId: string): Promise<string> => {
  for (const w of await listWorktrees(repoPath)) {
    if (await exists(await join(await sessionDir(w.path), `${sessionId}.jsonl`))) return w.path
  }
  return repoPath
}
