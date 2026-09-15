import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
}))

const files = new Map<string, string[]>() // code-review dir -> file names
const forbidden = new Set<string>() // path prefixes the fs scope refuses

vi.mock('@tauri-apps/plugin-fs', () => ({
  // mirrors the plugin: a path outside the capability's scope throws instead of answering false
  exists: async (p: string) => {
    if ([...forbidden].some((f) => p.startsWith(f))) throw new Error(`forbidden path: ${p}`)
    return files.has(p)
  },
  readDir: async (dir: string) => (files.get(dir) ?? []).map((name) => ({ name, isFile: true, isDirectory: false })),
}))
vi.mock('./log', () => ({ logWarn: vi.fn(), errText: (e: unknown) => String(e) }))
vi.mock('./worktrees', () => ({ listWorktrees: vi.fn() }))

import { logWarn } from './log'
import { scanReviewFiles } from './reviews'
import { listWorktrees } from './worktrees'

describe('scanReviewFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    files.clear()
    forbidden.clear()
  })

  it('maps a branch to its report in every checkout of the repo', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      { path: '/clone', branch: 'main' },
      { path: '/clone/.claude/worktrees/wt', branch: 'sentry-user-context' },
    ])
    files.set('/clone/AI_TASKS/code-review', ['2026-09-15-10-00-hub-instant-call-row.md', 'notes.txt'])
    files.set('/clone/.claude/worktrees/wt/AI_TASKS/code-review', ['2026-09-14-11-57-sentry-user-context.md'])

    expect(await scanReviewFiles('/clone')).toEqual(
      new Map([
        ['hub-instant-call-row', ['/clone/AI_TASKS/code-review/2026-09-15-10-00-hub-instant-call-row.md']],
        [
          'sentry-user-context',
          ['/clone/.claude/worktrees/wt/AI_TASKS/code-review/2026-09-14-11-57-sentry-user-context.md'],
        ],
      ]),
    )
  })

  it('skips a checkout the fs scope refuses instead of failing the whole scan', async () => {
    // a worktree parked outside the allowed roots (a temp dir): `exists` throws PathForbidden, which
    // used to take down the sync pass that was fetching the repo's PRs alongside this scan
    vi.mocked(listWorktrees).mockResolvedValue([
      { path: '/tmp/scratch/baseline', branch: 'baseline' },
      { path: '/clone', branch: 'main' },
    ])
    files.set('/clone/AI_TASKS/code-review', ['2026-09-15-10-00-main.md'])
    forbidden.add('/tmp/scratch')

    const byBranch = await scanReviewFiles('/clone')

    expect([...byBranch.keys()]).toEqual(['main'])
    expect(logWarn).toHaveBeenCalledWith('reviews', expect.stringContaining('/tmp/scratch/baseline'))
  })
})
