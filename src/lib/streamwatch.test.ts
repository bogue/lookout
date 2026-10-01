import { describe, expect, it } from 'vitest'
import { TRIGGERS, triggerFired, waitFor, waitingLabel } from './streamwatch'

const since = '2026-10-01T10:00:00.000Z'
const facts = (over: Partial<Parameters<typeof triggerFired>[1]> = {}) => ({ alerts: [], pr: null, ...over })

describe('waitFor', () => {
  it('starts a watch on the PR, now, with what to tell the agent when it fires', () => {
    const w = waitFor('author_pushed', 'owner/app#2', '2026-10-01T10:00:00.000Z')
    expect(w).toMatchObject({ trigger: 'author_pushed', ref: 'owner/app#2', since: '2026-10-01T10:00:00.000Z' })
    expect(w.resume).toMatch(/follow-up/i)
  })

  it('takes my own message for the agent', () => {
    expect(waitFor('ci_green', 'owner/app#2', since, 'now rebase').resume).toBe('now rebase')
  })
})

describe('triggerFired', () => {
  it('fires on an author push alert raised after the watch began', () => {
    const w = waitFor('author_pushed', 'owner/app#2', since)
    const late = { kind: 'addressed', taskId: 'owner/app#2', createdAt: '2026-10-01T11:00:00.000Z' }
    expect(triggerFired(w, facts({ alerts: [late] }))).toBe(true)
  })

  it('ignores an alert that was already there, or for another PR', () => {
    const w = waitFor('author_pushed', 'owner/app#2', since)
    const before = { kind: 'addressed', taskId: 'owner/app#2', createdAt: '2026-10-01T09:00:00.000Z' }
    const other = { kind: 'addressed', taskId: 'owner/app#3', createdAt: '2026-10-01T11:00:00.000Z' }
    expect(triggerFired(w, facts({ alerts: [before, other] }))).toBe(false)
  })

  it('fires on a new review of my PR', () => {
    const w = waitFor('reviewed', 'owner/app#2', since)
    const alert = { kind: 'awaiting_me', taskId: 'owner/app#2', createdAt: '2026-10-01T11:00:00.000Z' }
    expect(triggerFired(w, facts({ alerts: [alert] }))).toBe(true)
  })

  it('fires when CI is green, and when the PR merged', () => {
    expect(triggerFired(waitFor('ci_green', 'r#2', since), facts({ pr: { ciState: 'pass', state: 'open' } }))).toBe(
      true,
    )
    expect(triggerFired(waitFor('ci_green', 'r#2', since), facts({ pr: { ciState: 'pending', state: 'open' } }))).toBe(
      false,
    )
    expect(triggerFired(waitFor('merged', 'r#2', since), facts({ pr: { ciState: null, state: 'merged' } }))).toBe(true)
  })

  it('knows nothing about a PR the sync has not seen', () => {
    expect(triggerFired(waitFor('ci_green', 'r#2', since), facts())).toBe(false)
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
