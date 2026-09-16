import { Command } from '@tauri-apps/plugin-shell'
import { allowPath } from './fsscope'

export type Worktree = { path: string; branch: string | null }

// `git worktree list --porcelain` emits one blank-line-separated block per checkout:
//   worktree /Users/me/Projects/repo-perf
//   HEAD 925d3329…
//   branch refs/heads/directory-list-call-perf   (absent/"detached" when no branch is checked out)
export const parseWorktrees = (out: string): Worktree[] => {
  const list: Worktree[] = []
  for (const line of out.split('\n')) {
    const path = line.match(/^worktree (.+)$/)
    if (path) {
      list.push({ path: path[1].trim(), branch: null })
      continue
    }
    const branch = line.match(/^branch refs\/heads\/(.+)$/)
    const current = list.at(-1)
    if (branch && current) current.branch = branch[1].trim()
  }
  return list
}

// Worktrees move rarely but this is read per card on every poll, so keep the shell-out cheap.
const TTL_MS = 15_000
const cache = new Map<string, { at: number; list: Worktree[] }>()

// Every checkout of the repo — the clone itself plus its linked worktrees.
export const listWorktrees = async (repoPath: string): Promise<Worktree[]> => {
  const hit = cache.get(repoPath)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list
  let list: Worktree[] = []
  try {
    const out = await Command.create('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath }).execute()
    if (out.code === 0) list = parseWorktrees(out.stdout)
  } catch {
    // git missing or the path isn't a clone: the configured path is the only checkout we know of
  }
  if (!list.some((w) => w.path === repoPath)) list = [{ path: repoPath, branch: null }, ...list]
  // every checkout this returns is about to be read from (reports, sessions), and a linked
  // worktree can sit outside the clone, so widen the fs scope to each one here rather than at
  // each call site
  await Promise.all(list.map((w) => allowPath(w.path)))
  cache.set(repoPath, { at: Date.now(), list })
  return list
}

// Where a branch is actually checked out. Falls back to the clone, which is where it would be
// checked out if no worktree holds it.
export const pathForBranch = async (repoPath: string, branch: string): Promise<string> =>
  (await listWorktrees(repoPath)).find((w) => w.branch === branch)?.path ?? repoPath
