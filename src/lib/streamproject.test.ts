import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: vi.fn(() => ({ execute })) },
}))
vi.mock('./log', () => ({ errText: String, logWarn: vi.fn() }))

import { Command } from '@tauri-apps/plugin-shell'
import { guessProjects, parseProjectGuesses } from './streamproject'

const REPOS = ['owner/app', 'acme/api']

describe('parseProjectGuesses', () => {
  it('reads one project per task, in order', () => {
    expect(parseProjectGuesses('["acme/api", "owner/app"]', REPOS, 2)).toEqual(['acme/api', 'owner/app'])
  })

  it('reads the answer inside a code fence', () => {
    expect(parseProjectGuesses('```json\n["acme/api"]\n```', REPOS, 1)).toEqual(['acme/api'])
  })

  it('treats unsure, unknown and non-string answers as unknown', () => {
    expect(parseProjectGuesses('["unsure", "other/repo", 3]', REPOS, 3)).toEqual([null, null, null])
  })

  it('knows nothing when the answer is not the right shape', () => {
    expect(parseProjectGuesses('the first one is acme/api', REPOS, 1)).toEqual([null])
    expect(parseProjectGuesses('["acme/api"]', REPOS, 2)).toEqual([null, null])
  })
})

describe('guessProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execute.mockResolvedValue({ code: 0, stdout: '["owner/app"]', stderr: '' })
  })

  it('asks Haiku with no tools and no saved session, listing the projects and the tasks', async () => {
    expect(await guessProjects(['implement card 1'], REPOS)).toEqual(['owner/app'])
    const args = vi.mocked(Command.create).mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '', '--no-session-persistence']))
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain('acme/api')
    expect(prompt).toContain('1. implement card 1')
  })

  it('knows nothing when claude fails', async () => {
    execute.mockResolvedValue({ code: 1, stdout: '', stderr: 'rate limited' })
    expect(await guessProjects(['a', 'b'], REPOS)).toEqual([null, null])
    execute.mockRejectedValue(new Error('claude not found'))
    expect(await guessProjects(['a'], REPOS)).toEqual([null])
  })

  it('asks nothing when there is nothing to place', async () => {
    expect(await guessProjects([], REPOS)).toEqual([])
    expect(Command.create).not.toHaveBeenCalled()
  })
})
