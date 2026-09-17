import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: (_cmd: string, _args: string[], _opts?: unknown) => ({ execute }) },
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
