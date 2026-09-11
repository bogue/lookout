import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: (_cmd: string, _args: string[], _opts?: unknown) => ({ execute }) },
}))

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
