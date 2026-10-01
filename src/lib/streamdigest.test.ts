import { describe, expect, it } from 'vitest'
import type { StreamItem } from '../types'
import { digestOf, waitingCount } from './streamdigest'

const item = (over: Partial<StreamItem> = {}): StreamItem => ({
  id: 'a',
  repo: 'owner/app',
  groupId: null,
  title: 't',
  body: null,
  refKind: null,
  ref: null,
  status: 'needs_review',
  gate: 'result',
  sortOrder: null,
  priority: null,
  priorityReason: null,
  prioritySource: null,
  branch: null,
  checkout: null,
  sessionIds: [],
  createdBy: 'me',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
})

describe('waitingCount', () => {
  it('counts every card in Needs you', () => {
    const xs = [
      item({ status: 'needs_review' }),
      item({ status: 'failed' }),
      item({ status: 'question' }),
      item({ status: 'running' }),
      item({ status: 'done' }),
    ]
    expect(waitingCount(xs)).toBe(3)
  })
})

describe('digestOf', () => {
  const none = { seenAt: null, notifiedAt: null }

  it('groups every new waiting card into one notification', () => {
    const xs = [item({ id: 'a' }), item({ id: 'b', status: 'failed' }), item({ id: 'c', status: 'running' })]
    expect(digestOf(xs, none)).toEqual({
      title: 'Stream needs you',
      body: '2 new items are waiting for your feedback in Stream',
    })
  })

  it('says one item in the singular', () => {
    expect(digestOf([item()], none)?.body).toBe('1 new item is waiting for your feedback in Stream')
  })

  it('stays quiet when nothing waits', () => {
    expect(digestOf([item({ status: 'running' })], none)).toBeNull()
  })

  it('leaves out what I already saw on the board', () => {
    const xs = [item({ updatedAt: '2026-10-01T10:00:00.000Z' })]
    expect(digestOf(xs, { seenAt: '2026-10-01T10:05:00.000Z', notifiedAt: null })).toBeNull()
  })

  it('leaves out what an earlier notification already told me', () => {
    const xs = [
      item({ id: 'old', updatedAt: '2026-10-01T10:00:00.000Z' }),
      item({ id: 'new', updatedAt: '2026-10-01T10:20:00.000Z' }),
    ]
    expect(digestOf(xs, { seenAt: null, notifiedAt: '2026-10-01T10:15:00.000Z' })?.body).toBe(
      '1 new item is waiting for your feedback in Stream',
    )
  })
})
