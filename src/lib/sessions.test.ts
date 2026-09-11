import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home',
  join: async (...parts: string[]) => parts.join('/'),
}))

const files = new Map<string, string[]>() // session file path -> jsonl lines

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (p: string) => files.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`)),
  readDir: async (dir: string) =>
    [...files.keys()]
      .filter((f) => f.startsWith(`${dir}/`))
      .map((f) => ({ name: f.slice(dir.length + 1), isFile: true, isDirectory: false })),
  readTextFileLines: async (p: string) => files.get(p) ?? [],
}))

const worktrees = vi.hoisted(() => ({ listWorktrees: vi.fn() }))
vi.mock('./worktrees', () => worktrees)

const REPO = '/Projects/repo'
const PERF = '/Projects/repo-perf'
const dirFor = (checkout: string) => `/home/.claude/projects/${checkout.replace(/[^a-zA-Z0-9]/g, '-')}`

const line = (body: string, ts: string) => `{"timestamp":"${ts}","message":{"content":"${body}"}}`

const load = async () => {
  vi.resetModules()
  return import('./sessions')
}

beforeEach(() => {
  files.clear()
  worktrees.listWorktrees.mockReset()
  worktrees.listWorktrees.mockResolvedValue([
    { path: REPO, branch: 'main-work' },
    { path: PERF, branch: 'directory-list-call-perf' },
  ])
  files.set(`${dirFor(REPO)}/s1.jsonl`, [
    line('<command-name>/do-review</command-name><command-args>main-work</command-args>', '2026-09-01T10:00:00Z'),
  ])
  files.set(`${dirFor(PERF)}/s2.jsonl`, [
    line('<command-name>/handle-review</command-name><command-args></command-args>', '2026-09-10T08:00:00Z'),
  ])
})

describe('scanRepoSessions', () => {
  it('finds sessions started in a worktree and attributes them to its branch', async () => {
    const { scanRepoSessions } = await load()
    expect(await scanRepoSessions(REPO)).toEqual(
      new Map([
        ['main-work', ['s1']],
        ['directory-list-call-perf', ['s2']],
      ]),
    )
  })

  it('still keys clone sessions by the branch the command was run against, not by clone HEAD', async () => {
    files.delete(`${dirFor(PERF)}/s2.jsonl`)
    files.set(`${dirFor(REPO)}/s3.jsonl`, [
      line(
        '<command-name>/do-followup</command-name><command-args>other-branch</command-args>',
        '2026-09-02T10:00:00Z',
      ),
    ])
    const { scanRepoSessions } = await load()
    const byBranch = await scanRepoSessions(REPO)
    expect(byBranch.get('other-branch')).toEqual(['s3'])
    expect(byBranch.has('main-work')).toBe(true) // s1, from its own command args
  })

  it('ignores a clone session with no branch argument', async () => {
    files.clear()
    files.set(`${dirFor(REPO)}/s9.jsonl`, [
      line('<command-name>/handle-review</command-name><command-args></command-args>', '2026-09-02T10:00:00Z'),
    ])
    const { scanRepoSessions } = await load()
    expect(await scanRepoSessions(REPO)).toEqual(new Map())
  })
})

describe('session order', () => {
  it('orders sessions oldest first so the last id is the most recent', async () => {
    files.clear()
    files.set(`${dirFor(PERF)}/late.jsonl`, [
      line('<command-name>/handle-review</command-name>', '2026-09-10T08:00:00Z'),
    ])
    files.set(`${dirFor(PERF)}/early.jsonl`, [line('<command-name>/rebase</command-name>', '2026-09-02T08:00:00Z')])
    const { scanRepoSessions } = await load()
    expect((await scanRepoSessions(REPO)).get('directory-list-call-perf')).toEqual(['early', 'late'])
  })
})

describe('sessionsForBranch', () => {
  it('returns the worktree session with the checkout it ran in', async () => {
    const { sessionsForBranch } = await load()
    expect(await sessionsForBranch(REPO, 'directory-list-call-perf')).toEqual([
      {
        sessionId: 's2',
        command: 'handle-review',
        branch: 'directory-list-call-perf',
        ts: '2026-09-10T08:00:00Z',
        cwd: PERF,
      },
    ])
  })
})

describe('sessionCwd', () => {
  it('locates the checkout whose project dir holds the session', async () => {
    const { sessionCwd } = await load()
    expect(await sessionCwd(REPO, 's2')).toBe(PERF)
    expect(await sessionCwd(REPO, 's1')).toBe(REPO)
  })

  it('falls back to the clone for an unknown session', async () => {
    const { sessionCwd } = await load()
    expect(await sessionCwd(REPO, 'gone')).toBe(REPO)
  })
})
