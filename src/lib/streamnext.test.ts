import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: vi.fn(() => ({ execute })) },
}))
vi.mock('./log', () => ({ errText: String, logWarn: vi.fn() }))

import { Command } from '@tauri-apps/plugin-shell'
import { nextStepOf, parseNextStep, suggestNextStep } from './streamnext'

describe('parseNextStep', () => {
  it('reads a headline and its actions', () => {
    const json = JSON.stringify({
      headline: 'README updated and committed; nothing pushed',
      actions: [
        { label: 'Push and open a draft PR', reply: 'Push the branch and open a draft PR.' },
        { label: 'Done', done: true },
      ],
    })
    expect(parseNextStep(json)).toEqual({
      headline: 'README updated and committed; nothing pushed',
      actions: [
        { label: 'Push and open a draft PR', reply: 'Push the branch and open a draft PR.' },
        { label: 'Done', reply: null },
      ],
    })
  })

  it('reads the answer inside a code fence', () => {
    expect(parseNextStep('```json\n{"headline":"ok","actions":[{"label":"Done","done":true}]}\n```')).toMatchObject({
      headline: 'ok',
    })
  })

  it('keeps at most three actions and drops broken ones', () => {
    const actions = [
      { label: 'A', reply: 'a' },
      { label: '', reply: 'no label' },
      { label: 'B' }, // neither a reply nor done
      { label: 'C', reply: 'c' },
      { label: 'D', reply: 'd' },
      { label: 'E', reply: 'e' },
    ]
    expect(parseNextStep(JSON.stringify({ headline: 'h', actions }))?.actions.map((a) => a.label)).toEqual([
      'A',
      'C',
      'D',
    ])
  })

  it('knows nothing from prose or without any usable action', () => {
    expect(parseNextStep('I think you should push')).toBeNull()
    expect(parseNextStep(JSON.stringify({ headline: 'h', actions: [] }))).toBeNull()
  })
})

describe('nextStepOf', () => {
  it('reads the suggestion saved after the latest result, and only that one', () => {
    const events = [
      { kind: 'result', text: 'first' },
      { kind: 'next', text: '{"headline":"old","actions":[{"label":"Done","done":true}]}' },
      { kind: 'reply', text: 'redo it' },
      { kind: 'result', text: 'second' },
    ]
    expect(nextStepOf(events)).toBeNull()
    expect(
      nextStepOf([...events, { kind: 'next', text: '{"headline":"new","actions":[{"label":"Done","done":true}]}' }])
        ?.headline,
    ).toBe('new')
  })
})

describe('suggestNextStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execute.mockResolvedValue({ code: 0, stdout: '{"headline":"h","actions":[{"label":"Done","done":true}]}' })
  })

  it('asks Haiku with no tools and no saved session, giving it the task and the result', async () => {
    expect(await suggestNextStep({ title: 'fix login', body: null, ref: null }, 'Fixed and committed.')).toMatchObject({
      headline: 'h',
    })
    const args = vi.mocked(Command.create).mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '', '--no-session-persistence']))
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain('fix login')
    expect(prompt).toContain('Fixed and committed.')
  })

  it('knows nothing when claude fails', async () => {
    execute.mockResolvedValue({ code: 1, stdout: '', stderr: 'nope' })
    expect(await suggestNextStep({ title: 't', body: null, ref: null }, 'r')).toBeNull()
  })
})
