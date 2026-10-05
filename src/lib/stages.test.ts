import { describe, expect, it } from 'vitest'
import { advanceStage, parseStage } from './stages'

describe('advanceStage', () => {
  it('moves a card forward', () => {
    expect(advanceStage('discovered', 'reviewing')).toBe('reviewing')
    expect(advanceStage('reviewing', 'reviewed')).toBe('reviewed')
    expect(advanceStage('reviewed', 'followup')).toBe('followup')
  })

  it('keeps a follow-up card in follow-up when a review re-runs', () => {
    expect(advanceStage('followup', 'reviewed')).toBe('followup')
    expect(advanceStage('followup', 'reviewing')).toBe('followup')
  })

  it('never pulls a done card back', () => {
    expect(advanceStage('done', 'reviewed')).toBe('done')
    expect(advanceStage('done', 'followup')).toBe('done')
  })

  it('is a no-op for the same stage', () => expect(advanceStage('reviewed', 'reviewed')).toBe('reviewed'))
})

describe('parseStage', () => {
  it('reads the id the database stores', () => {
    expect(parseStage('needs_review')).toBe('needs_review')
    expect(parseStage('followup')).toBe('followup')
  })

  it('reads the label the board shows', () => {
    expect(parseStage('Needs Review')).toBe('needs_review')
    expect(parseStage('In Review')).toBe('reviewing')
    expect(parseStage('Follow-up')).toBe('followup')
    expect(parseStage('Discovery')).toBe('discovered')
  })

  it('ignores case, spaces and dashes', () => {
    expect(parseStage('needs-review')).toBe('needs_review')
    expect(parseStage('NEEDSREVIEW')).toBe('needs_review')
    expect(parseStage('follow up')).toBe('followup')
  })

  it('still reads a retired id, so old scripts and saved configs keep working', () =>
    expect(parseStage('inbox')).toBe('needs_review'))

  it('returns null for anything else', () => {
    expect(parseStage('nope')).toBeNull()
    expect(parseStage('')).toBeNull()
  })
})
