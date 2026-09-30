import { describe, expect, it } from 'vitest'
import { cardActions, snoozeAction } from './cardactions'

const ids = (c: Parameters<typeof cardActions>[0]) => cardActions(c).map((a) => a.id)
const base = { snoozed: false, hasSession: false, isPr: false, running: false }

describe('cardActions', () => {
  it('offers snooze, open and remove on a review card with no session', () => {
    expect(ids(base)).toEqual(['snooze', 'open-browser', 'remove'])
  })

  it('adds resume once the card has a session', () => {
    expect(ids({ ...base, hasSession: true })).toEqual(['snooze', 'resume', 'open-browser', 'remove'])
  })

  it('never removes a card from the Pull Requests board: it is mine, not a review', () => {
    expect(ids({ ...base, isPr: true })).not.toContain('remove')
  })

  it('offers kill only while a run is going, last and marked as dangerous', () => {
    const actions = cardActions({ ...base, running: true })
    expect(actions.at(-1)).toEqual(expect.objectContaining({ id: 'kill', danger: true }))
    expect(ids(base)).not.toContain('kill')
  })

  it('turns snooze into unsnooze on a snoozed card', () => {
    const snooze = cardActions({ ...base, snoozed: true })[0]
    expect(snooze).toEqual(expect.objectContaining({ id: 'snooze', label: 'Unsnooze' }))
    expect(cardActions(base)[0].label).toBe('Snooze')
  })

  it('builds the list from the same snooze action the PR panel shows on its own', () => {
    expect(cardActions(base)[0]).toEqual(snoozeAction(false))
    expect(cardActions({ ...base, snoozed: true })[0]).toEqual(snoozeAction(true))
  })
})
