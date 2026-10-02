import { describe, expect, it } from 'vitest'
import { alertAt, checkTrigger, parseWaitFor, TRIGGERS, waitFor, waitingLabel } from './streamwatch'

const since = '2026-10-01T10:00:00.000Z'
const facts = (over: Partial<Parameters<typeof checkTrigger>[1]> = {}) => ({ alerts: [], pr: null, ...over })

describe('waitFor', () => {
  it('starts a watch on the PR, now, with what to tell the agent when it fires', () => {
    const w = waitFor('author_pushed', 'owner/app#2', since)
    expect(w).toMatchObject({ trigger: 'author_pushed', ref: 'owner/app#2', since, armed: true })
    expect(w.resume).toMatch(/follow-up/i)
  })

  it('takes my own message for the agent', () => {
    expect(waitFor('ci_green', 'owner/app#2', since, 'now rebase').resume).toBe('now rebase')
  })

  it('survives a round trip through the database, armed or not', () => {
    const w = waitFor('ci_green', 'owner/app#2', since, undefined, false)
    expect(parseWaitFor(JSON.stringify(w))).toEqual(w)
  })
})

describe('alertAt', () => {
  it('reads the event time out of the alert key, which can hold colons', () => {
    expect(alertAt('addressed:owner/app#2:2026-10-01T11:00:00Z', 'addressed', 'owner/app#2', 'x')).toBe(
      '2026-10-01T11:00:00Z',
    )
  })

  it('falls back to when the row was stored for a key with no event time', () => {
    expect(alertAt('ci_fail:owner/app#2', 'ci_fail', 'owner/app#2', '2026-10-01T09:00:00Z')).toBe(
      '2026-10-01T09:00:00Z',
    )
  })
})

describe('checkTrigger', () => {
  it('fires on an author push that happened after the watch began', () => {
    const w = waitFor('author_pushed', 'owner/app#2', since)
    const late = { kind: 'addressed', taskId: 'owner/app#2', at: '2026-10-01T11:00:00.000Z' }
    expect(checkTrigger(w, facts({ alerts: [late] }))).toBe('fire')
  })

  it('ignores a push from before the watch, even when the sync only stored it after', () => {
    const w = waitFor('author_pushed', 'owner/app#2', since)
    const before = { kind: 'addressed', taskId: 'owner/app#2', at: '2026-10-01T09:00:00.000Z' }
    const other = { kind: 'addressed', taskId: 'owner/app#3', at: '2026-10-01T11:00:00.000Z' }
    expect(checkTrigger(w, facts({ alerts: [before, other] }))).toBe('wait')
  })

  it('fires on a new review of my PR', () => {
    const w = waitFor('reviewed', 'owner/app#2', since)
    const alert = { kind: 'awaiting_me', taskId: 'owner/app#2', at: '2026-10-01T11:00:00.000Z' }
    expect(checkTrigger(w, facts({ alerts: [alert] }))).toBe('fire')
  })

  it('waits for CI to go green again when it was already green at the start (a push is coming)', () => {
    const w = waitFor('ci_green', 'r#2', since, undefined, false)
    expect(checkTrigger(w, facts({ pr: { ciState: 'pass', state: 'open' } }))).toBe('wait')
    expect(checkTrigger(w, facts({ pr: { ciState: 'pending', state: 'open' } }))).toBe('arm')
    expect(checkTrigger({ ...w, armed: true }, facts({ pr: { ciState: 'pass', state: 'open' } }))).toBe('fire')
  })

  it('fires on green right away when CI was not green at the start', () => {
    const w = waitFor('ci_green', 'r#2', since, undefined, true)
    expect(checkTrigger(w, facts({ pr: { ciState: 'pass', state: 'open' } }))).toBe('fire')
    expect(checkTrigger(w, facts({ pr: { ciState: 'fail', state: 'open' } }))).toBe('wait')
  })

  it('fires when the PR merged', () => {
    expect(checkTrigger(waitFor('merged', 'r#2', since), facts({ pr: { ciState: null, state: 'merged' } }))).toBe(
      'fire',
    )
  })

  it('knows nothing about a PR the sync has not seen', () => {
    expect(checkTrigger(waitFor('ci_green', 'r#2', since), facts())).toBe('wait')
  })
})

describe('waitingLabel', () => {
  it('says what the card waits for', () => {
    expect(waitingLabel(waitFor('author_pushed', 'owner/app#2', since))).toBe('waiting for the author to push on #2')
  })

  it('has a label for every trigger', () => {
    for (const t of TRIGGERS) expect(waitingLabel(waitFor(t.value, 'owner/app#2', since))).toContain('#2')
  })
})
