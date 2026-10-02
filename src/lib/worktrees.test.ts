import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: (_cmd: string, args: string[], opts?: { cwd?: string }) => ({ execute: () => execute(args, opts) }),
  },
}))

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/data',
  join: async (...parts: string[]) => parts.join('/'),
}))

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }))

const PORCELAIN = `worktree /Projects/repo
HEAD c82516fa
branch refs/heads/main-work

worktree /Projects/repo-perf
HEAD 925d3329
branch refs/heads/directory-list-call-perf

worktree /Projects/repo-detached
HEAD 102d61b2
detached
`

const load = async () => {
  vi.resetModules()
  return import('./worktrees')
}

beforeEach(() => {
  execute.mockReset()
  execute.mockResolvedValue({ code: 0, stdout: PORCELAIN, stderr: '' })
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
})

describe('parseWorktrees', () => {
  it('reads one entry per block, branch only when attached', async () => {
    const { parseWorktrees } = await load()
    expect(parseWorktrees(PORCELAIN)).toEqual([
      { path: '/Projects/repo', branch: 'main-work' },
      { path: '/Projects/repo-perf', branch: 'directory-list-call-perf' },
      { path: '/Projects/repo-detached', branch: null },
    ])
  })

  it('keeps slashes in branch names', async () => {
    const { parseWorktrees } = await load()
    expect(parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/feat/sub-branch\n')).toEqual([
      { path: '/r', branch: 'feat/sub-branch' },
    ])
  })
})

describe('listWorktrees', () => {
  it('caches per repo instead of shelling out on every card', async () => {
    const { listWorktrees } = await load()
    await listWorktrees('/Projects/repo')
    await listWorktrees('/Projects/repo')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('falls back to the clone itself when git fails', async () => {
    execute.mockResolvedValue({ code: 128, stdout: '', stderr: 'not a git repository' })
    const { listWorktrees } = await load()
    expect(await listWorktrees('/Projects/repo')).toEqual([{ path: '/Projects/repo', branch: null }])
  })

  it('always includes the clone path, even when git lists it elsewhere', async () => {
    execute.mockResolvedValue({
      code: 0,
      stdout: 'worktree /Projects/other\nHEAD abc\nbranch refs/heads/x\n',
      stderr: '',
    })
    const { listWorktrees } = await load()
    expect((await listWorktrees('/Projects/repo')).map((w) => w.path)).toContain('/Projects/repo')
  })
})

describe('fs scope', () => {
  it('widens the scope to every checkout, including worktrees outside the clone', async () => {
    const { listWorktrees } = await load()
    await listWorktrees('/Projects/repo')
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'allow_path').map(([, args]) => args)).toEqual([
      { path: '/Projects/repo' },
      { path: '/Projects/repo-perf' },
      { path: '/Projects/repo-detached' },
    ])
  })

  it('asks once per path, not on every poll', async () => {
    const { listWorktrees } = await load()
    await listWorktrees('/Projects/repo')
    invoke.mockClear()
    // same porcelain, so the three known checkouts come back again; only the new clone is asked for
    await listWorktrees('/Projects/repo-other')
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === 'allow_path').map(([, args]) => (args as { path: string }).path),
    ).toEqual(['/Projects/repo-other'])
  })

  it('retries a path whose widen failed instead of caching the failure', async () => {
    invoke.mockRejectedValueOnce(new Error('nope'))
    const { listWorktrees } = await load()
    await listWorktrees('/Projects/repo')
    const first = invoke.mock.calls.filter(([cmd]) => cmd === 'allow_path').length
    invoke.mockClear()
    await listWorktrees('/Projects/repo-again')
    expect(first).toBe(3)
    expect(invoke.mock.calls.filter(([, args]) => (args as { path: string }).path === '/Projects/repo')).toHaveLength(1)
  })

  it('holds the second caller until a widen already in flight lands', async () => {
    let landed: () => void = () => {}
    invoke.mockReturnValueOnce(new Promise<void>((resolve) => (landed = () => resolve())))
    const { listWorktrees } = await load()
    // sync.ts scans sessions and reviews for the same repo at once, and neither goes through the
    // TTL cache on the first pass: the second scan must not read before the scope is open
    let second = false
    const calls = Promise.all([
      listWorktrees('/Projects/repo'),
      listWorktrees('/Projects/repo').then(() => {
        second = true
      }),
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(second).toBe(false)
    landed()
    await calls
    expect(second).toBe(true)
  })
})

describe('pathForBranch', () => {
  it('resolves the worktree holding the branch', async () => {
    const { pathForBranch } = await load()
    expect(await pathForBranch('/Projects/repo', 'directory-list-call-perf')).toBe('/Projects/repo-perf')
  })

  it('falls back to the clone when no worktree holds the branch', async () => {
    const { pathForBranch } = await load()
    expect(await pathForBranch('/Projects/repo', 'never-checked-out')).toBe('/Projects/repo')
  })
})

describe('chatCheckout', () => {
  const WT = '/data/worktrees/-Projects-repo-pr-7'
  const REMOTES = 'fork\tgit@github.com:me/app.git (fetch)\nupstream\tgit@github.com:Acme/App.git (fetch)\n'
  type Opts = { hasWorktree?: boolean; dirty?: boolean; fetchFails?: boolean; ahead?: boolean; remotes?: string }
  // answers each git call by its subcommand; `worktree list` reflects whether the PR worktree exists
  const git = (opts: Opts = {}) =>
    execute.mockImplementation(async (args: string[]) => {
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
      const [sub] = args
      if (sub === 'worktree' && args[1] === 'list')
        return ok(`${PORCELAIN}${opts.hasWorktree ? `\nworktree ${WT}\nHEAD 111\ndetached\n` : ''}`)
      if (sub === 'remote') return ok(opts.remotes ?? REMOTES)
      if (sub === 'fetch') return opts.fetchFails ? { code: 1, stdout: '', stderr: 'no such ref' } : ok()
      if (sub === 'rev-parse') return ok('abc123\n')
      if (sub === 'status') return ok(opts.dirty ? ' M file.ts\n' : '')
      if (sub === 'merge-base') return opts.ahead ? { code: 1, stdout: '', stderr: '' } : ok()
      return ok()
    })
  const calls = () => execute.mock.calls.map(([args, o]) => [args.join(' '), o?.cwd])
  const run = async (repo = 'acme/app') => (await load()).chatCheckout('/Projects/repo', repo, 'never-checked-out', 7)

  it('uses the checkout that already holds the branch', async () => {
    git()
    const { chatCheckout } = await load()
    expect(await chatCheckout('/Projects/repo', 'acme/app', 'directory-list-call-perf', 7)).toBe('/Projects/repo-perf')
    expect(calls().some(([a]) => a.startsWith('fetch'))).toBe(false)
  })

  // the clone's own branch has nothing to do with the PR: never chat from it. The PR head comes
  // from the remote that is the PR's repo (a fork clone's origin is not), into a ref of Lookout's own
  it('adds a worktree on the PR head when no checkout holds the branch', async () => {
    git()
    expect(await run()).toBe(WT)
    expect(calls()).toContainEqual(['fetch upstream +pull/7/head:refs/lookout/pr-7', '/Projects/repo'])
    expect(calls()).toContainEqual(['rev-parse refs/lookout/pr-7', '/Projects/repo'])
    expect(calls()).toContainEqual([`worktree add --detach ${WT} abc123`, '/Projects/repo'])
  })

  it('prunes worktrees whose dir is gone before looking for its own', async () => {
    git()
    await run()
    const order = calls().map(([a]) => a)
    expect(order.indexOf('worktree prune')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('worktree prune')).toBeLessThan(order.findIndex((a) => a.startsWith('worktree add')))
  })

  it('fails when no remote is the PR repo', async () => {
    git({ remotes: 'origin\tgit@github.com:me/other.git (fetch)\n' })
    await expect(run()).rejects.toThrow(/acme\/app/)
  })

  it('moves a clean PR worktree to the latest head', async () => {
    git({ hasWorktree: true })
    expect(await run()).toBe(WT)
    expect(calls()).toContainEqual(['checkout --detach abc123', WT])
    expect(calls().some(([a]) => a.startsWith('worktree add'))).toBe(false)
  })

  it('leaves a dirty PR worktree as it is', async () => {
    git({ hasWorktree: true, dirty: true })
    expect(await run()).toBe(WT)
    expect(calls().some(([a]) => a.startsWith('checkout'))).toBe(false)
  })

  // claude may have committed there: moving HEAD would strand those commits
  it('leaves a PR worktree holding commits not on the PR head', async () => {
    git({ hasWorktree: true, ahead: true })
    expect(await run()).toBe(WT)
    expect(calls().some(([a]) => a.startsWith('checkout'))).toBe(false)
  })

  it('fails instead of falling back to the clone when the PR head cannot be fetched', async () => {
    git({ fetchFails: true })
    await expect(run()).rejects.toThrow(/pull\/7\/head/)
  })

  it('sets up one worktree at a time: a double send does not add it twice', async () => {
    git()
    const { chatCheckout } = await load()
    const [a, b] = await Promise.all([
      chatCheckout('/Projects/repo', 'acme/app', 'never-checked-out', 7),
      chatCheckout('/Projects/repo', 'acme/app', 'never-checked-out', 7),
    ])
    expect([a, b]).toEqual([WT, WT])
    expect(calls().filter(([x]) => x.startsWith('worktree add'))).toHaveLength(1)
  })
})
