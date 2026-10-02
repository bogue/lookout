import { appDataDir, join } from '@tauri-apps/api/path'
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

const git = async (args: string[], cwd: string) => {
  const out = await Command.create('git', args, { cwd }).execute()
  if (out.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr.trim()}`)
  return out.stdout.trim()
}

// The remote that is `owner/repo` on GitHub. A fork clone's origin is the fork, and fetching its
// pull/<n>/head would give the fork's own PR #n.
const remoteFor = async (repoPath: string, repo: string) => {
  const want = repo.toLowerCase()
  for (const line of (await git(['remote', '-v'], repoPath)).split('\n')) {
    const [name, url = ''] = line.split(/\s+/)
    const slug = url.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1]?.toLowerCase()
    if (slug === want) return name
  }
  throw new Error(`no git remote of ${repoPath} points at ${repo}`)
}

const setUp = async (repoPath: string, repo: string, prNumber: number, dir: string) => {
  const ref = `refs/lookout/pr-${prNumber}` // Lookout's own ref: FETCH_HEAD is anyone's to overwrite
  await git(['fetch', await remoteFor(repoPath, repo), `+pull/${prNumber}/head:${ref}`], repoPath)
  const head = await git(['rev-parse', ref], repoPath)
  await git(['worktree', 'prune'], repoPath) // forget a worktree whose dir was deleted by hand
  cache.delete(repoPath)
  if (!(await listWorktrees(repoPath)).some((w) => w.path === dir))
    await git(['worktree', 'add', '--detach', dir, head], repoPath)
  // an earlier chat's edits or commits stay put; a clean one with nothing of its own follows the PR
  else if (!(await git(['status', '--porcelain'], dir))) {
    const behind = await Command.create('git', ['merge-base', '--is-ancestor', 'HEAD', head], { cwd: dir }).execute()
    if (behind.code === 0) await git(['checkout', '--detach', head], dir)
  }
  cache.delete(repoPath)
  await allowPath(dir)
  return dir
}

// one setup per worktree at a time: a double send must not `worktree add` the same dir twice
const settingUp = new Map<string, Promise<string>>()

// Where a card's chat runs: a chat is about one PR, whatever the clone has checked out. The branch's
// own checkout when there is one, else a worktree Lookout keeps for the PR, detached on its latest
// head (pull/<n>/head also covers a PR from a fork). Never the clone on some unrelated branch.
export const chatCheckout = async (repoPath: string, repo: string, branch: string, prNumber: number) => {
  const held = (await listWorktrees(repoPath)).find((w) => w.branch === branch)
  if (held) return held.path
  const dir = await join(await appDataDir(), 'worktrees', `${repoPath.replace(/[^a-zA-Z0-9]/g, '-')}-pr-${prNumber}`)
  const inflight = settingUp.get(dir)
  if (inflight) return inflight
  const setup = setUp(repoPath, repo, prNumber, dir).finally(() => settingUp.delete(dir))
  settingUp.set(dir, setup)
  return setup
}
