import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: vi.fn(() => ({ execute })) },
}))
vi.mock('./log', () => ({ errText: String, logWarn: vi.fn() }))

import { Command } from '@tauri-apps/plugin-shell'
import { assessRisk, localRisk, needsRiskCheck, parseRisk, riskText } from './streamrisk'

const card = (over: Record<string, unknown> = {}) => ({
  title: 'fix the login typo',
  body: null,
  steps: [],
  guidelines: null,
  gate: null,
  stepIndex: 0,
  sessionIds: [],
  waitFor: null,
  ...over,
})

describe('riskText', () => {
  it('is everything the agent will be told: title, notes, steps, guidelines', () => {
    const t = riskText(
      card({ body: 'see spec', steps: [{ prompt: 'plan it', gate: true }], guidelines: 'test first' }) as never,
    )
    expect(t).toContain('fix the login typo')
    expect(t).toContain('see spec')
    expect(t).toContain('plan it')
    expect(t).toContain('test first')
  })
})

describe('needsRiskCheck', () => {
  it('checks a card about to start for the first time', () => {
    expect(needsRiskCheck(card() as never)).toBe(true)
  })

  it('skips one I already let run, and one that has started before', () => {
    expect(needsRiskCheck(card({ gate: 'risk-ok' }) as never)).toBe(false)
    expect(needsRiskCheck(card({ sessionIds: ['s1'] }) as never)).toBe(false)
    expect(needsRiskCheck(card({ stepIndex: 1 }) as never)).toBe(false)
  })

  it('skips one waking from a watch: it passed (or I allowed it) before it started waiting', () => {
    expect(needsRiskCheck(card({ waitFor: { trigger: 'reviewed' } }) as never)).toBe(false)
  })
})

describe('localRisk', () => {
  it.each([
    'create a release for the app',
    'tag v1.2 and publish to npm',
    'deploy the fix to production',
    'merge PR #2 once green',
    'push and open a PR',
    'post a comment on #4',
    'update the Notion card',
    'move the Jira ticket to done',
    'send the team a Slack message',
    'delete the old branches',
    'force-push the rebased branch',
  ])('calls "%s" risky without asking', (title) => {
    expect(localRisk(card({ title }) as never)).toMatchObject({ risky: true })
  })

  it('ignores what the task forbids ("never push", "do not merge")', () => {
    const c = card({
      title: 'implement card 1',
      guidelines: 'Never push on your own. Do not merge. No deploy. Without pushing anything.',
    })
    expect(localRisk(c as never)).toBeNull()
  })

  it('leaves plain local work to Haiku', () => {
    expect(localRisk(card({ title: 'implement card 1 with tests' }) as never)).toBeNull()
  })
})

describe('parseRisk', () => {
  it('reads the verdict', () => {
    expect(parseRisk('{"risk":"safe","reason":"local refactor"}')).toEqual({ risky: false, reason: 'local refactor' })
    expect(parseRisk('```json\n{"risk":"risky","reason":"emails people"}\n```')).toEqual({
      risky: true,
      reason: 'emails people',
    })
  })

  it('fails closed on anything else', () => {
    expect(parseRisk('probably fine')).toEqual({ risky: true, reason: 'Haiku gave no clear verdict' })
    expect(parseRisk('{"risk":"maybe"}')).toEqual({ risky: true, reason: 'Haiku gave no clear verdict' })
  })
})

describe('assessRisk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execute.mockResolvedValue({ code: 0, stdout: '{"risk":"safe","reason":"local only"}', stderr: '' })
  })

  it('answers locally for an obvious one, without calling Haiku', async () => {
    expect(await assessRisk(card({ title: 'deploy to prod' }) as never)).toMatchObject({ risky: true })
    expect(Command.create).not.toHaveBeenCalled()
  })

  it('asks Haiku with no tools and no saved session, and remembers the answer for the same task', async () => {
    const c = card({ title: 'rename a helper in utils, unique 1' })
    expect(await assessRisk(c as never)).toEqual({ risky: false, reason: 'local only' })
    expect(await assessRisk(c as never)).toEqual({ risky: false, reason: 'local only' })
    expect(Command.create).toHaveBeenCalledTimes(1)
    const args = vi.mocked(Command.create).mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '', '--no-session-persistence']))
  })

  it('fails closed when claude fails, and does not remember that', async () => {
    execute.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'rate limited' })
    const c = card({ title: 'rename a helper in utils, unique 2' })
    expect(await assessRisk(c as never)).toMatchObject({ risky: true })
    expect(await assessRisk(c as never)).toEqual({ risky: false, reason: 'local only' })
  })
})
