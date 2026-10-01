import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: vi.fn(() => ({ execute })) },
}))
vi.mock('./log', () => ({ errText: String, logWarn: vi.fn() }))

import { Command } from '@tauri-apps/plugin-shell'
import { localPriority, needsRating, parsePriorities, ratePriorities } from './streampriority'

const card = (over: Record<string, unknown> = {}) => ({
  status: 'needs_review',
  priority: null,
  prioritySource: null,
  ...over,
})

describe('needsRating', () => {
  it('rates a card in Needs you that has no priority yet', () => {
    expect(needsRating(card() as never)).toBe(true)
    expect(needsRating(card({ status: 'question' }) as never)).toBe(true)
  })

  it('leaves a rated card, one I set myself, and cards elsewhere alone', () => {
    expect(needsRating(card({ priority: 'high', prioritySource: 'haiku' }) as never)).toBe(false)
    expect(needsRating(card({ priority: 'low', prioritySource: 'me' }) as never)).toBe(false)
    expect(needsRating(card({ status: 'queued' }) as never)).toBe(false)
  })
})

describe('localPriority', () => {
  it('rates a failed run high without asking Haiku', () => {
    expect(localPriority(card({ status: 'failed' }) as never)).toEqual({
      priority: 'high',
      reason: 'The agent failed: nothing moves until you look',
    })
  })

  it('leaves the rest to Haiku', () => {
    expect(localPriority(card() as never)).toBeNull()
  })
})

describe('parsePriorities', () => {
  it('reads one rating per card, in order', () => {
    const json = JSON.stringify([
      { priority: 'urgent', reason: 'Teammate blocked on this review' },
      { priority: 'low', reason: 'Cosmetic' },
    ])
    expect(parsePriorities(json, 2)).toEqual([
      { priority: 'urgent', reason: 'Teammate blocked on this review' },
      { priority: 'low', reason: 'Cosmetic' },
    ])
  })

  it('falls back to normal for an unknown level, and for everything on a bad answer', () => {
    expect(parsePriorities('[{"priority":"asap","reason":"x"}]', 1)).toEqual([{ priority: 'normal', reason: 'x' }])
    expect(parsePriorities('no idea', 2)).toEqual([
      { priority: 'normal', reason: null },
      { priority: 'normal', reason: null },
    ])
  })
})

describe('ratePriorities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execute.mockResolvedValue({ code: 0, stdout: '[{"priority":"high","reason":"r"}]', stderr: '' })
  })

  it('asks Haiku with no tools and no saved session, listing each card', async () => {
    expect(
      await ratePriorities([{ title: 'fix login', waitsOn: 'review of a result', excerpt: 'Done.', waiting: '2h' }]),
    ).toEqual([{ priority: 'high', reason: 'r' }])
    const args = vi.mocked(Command.create).mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '', '--no-session-persistence']))
    expect(args[args.indexOf('-p') + 1]).toContain('fix login')
  })

  it('rates normal when claude fails (a wrong rank only costs order)', async () => {
    execute.mockResolvedValue({ code: 1, stdout: '', stderr: 'nope' })
    expect(await ratePriorities([{ title: 't', waitsOn: 'x', excerpt: '', waiting: '1m' }])).toEqual([
      { priority: 'normal', reason: null },
    ])
  })

  it('asks nothing for no cards', async () => {
    expect(await ratePriorities([])).toEqual([])
    expect(Command.create).not.toHaveBeenCalled()
  })
})
