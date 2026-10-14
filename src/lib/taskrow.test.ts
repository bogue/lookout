import { describe, expect, it } from 'vitest'
import { stageUpdate } from './taskrow'

const NOW = '2026-09-20T10:00:00.000Z'

describe('stageUpdate', () => {
  it('stamps removed_at when a card goes back to Discovery', () => {
    expect(stageUpdate('discovered', NOW)).toEqual({
      stage: 'discovered',
      done_at: null,
      removed_at: NOW,
      updated_at: NOW,
    })
  })

  it('clears removed_at once the card is on the board again', () => {
    expect(stageUpdate('watching', NOW).removed_at).toBeNull()
  })

  it('stamps done_at only in Done', () => {
    expect(stageUpdate('done', NOW)).toMatchObject({ done_at: NOW, removed_at: null })
  })
})
