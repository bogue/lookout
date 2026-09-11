import { describe, expect, it } from 'vitest'
import { advanceColumn, resolveColumn } from './prcolumns'

describe('advanceColumn — forward-only along waiting < in_review < ready < done', () => {
  it('moves forward', () => {
    expect(advanceColumn('waiting', 'in_review')).toBe('in_review')
    expect(advanceColumn('in_review', 'ready')).toBe('ready')
    expect(advanceColumn('ready', 'done')).toBe('done')
  })

  it('refuses to move backward', () => {
    expect(advanceColumn('in_review', 'waiting')).toBe('in_review')
    expect(advanceColumn('ready', 'in_review')).toBe('ready')
    expect(advanceColumn('done', 'waiting')).toBe('done')
  })

  it('is a no-op when the target is where we already are', () => expect(advanceColumn('ready', 'ready')).toBe('ready'))
})

describe('resolveColumn — GitHub only gets a say when its verdict changed', () => {
  it('advances when the derived column moved up', () =>
    expect(resolveColumn('waiting', 'waiting', 'in_review')).toBe('in_review'))

  it('keeps In Review when a re-requested review suppresses the review that earned it', () =>
    expect(resolveColumn('in_review', 'in_review', 'waiting')).toBe('in_review'))

  it('keeps In Review when the PR is flipped back to draft', () =>
    expect(resolveColumn('in_review', 'in_review', 'waiting')).toBe('in_review'))

  it('promotes to Ready when a human approves', () =>
    expect(resolveColumn('in_review', 'in_review', 'ready')).toBe('ready'))

  it('leaves a manual drop alone while GitHub keeps saying the same thing', () => {
    // dragged Ready -> Waiting: stored moved, lastDerived stayed at what earned the promotion
    expect(resolveColumn('waiting', 'ready', 'ready')).toBe('waiting')
  })

  it('lifts a dragged-down card only once GitHub genuinely moves again', () => {
    // same card, reviewer now requests changes: derived ready -> in_review is a real change
    expect(resolveColumn('waiting', 'ready', 'in_review')).toBe('in_review')
  })

  it('never lets a change pull a card below where it sits', () =>
    expect(resolveColumn('ready', 'ready', 'waiting')).toBe('ready'))

  it('sends a merged PR to Done from anywhere', () => {
    expect(resolveColumn('waiting', 'waiting', 'done')).toBe('done')
    expect(resolveColumn('in_review', 'ready', 'done')).toBe('done')
  })
})
