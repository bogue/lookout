import { describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ capturedReviewsForTask: vi.fn() }))
vi.mock('./gh', () => ({ fetchPrTimeline: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./sessions', () => ({ sessionsForBranch: vi.fn() }))
vi.mock('./alerts', () => ({ reviewFileTs: vi.fn() }))
vi.mock('./prboard', () => ({ isBot: vi.fn(), reviewFlavor: vi.fn() }))

import { type FeedEvent, linkReports, mergeReports } from './feed'

const me = { login: 'me' }
const session = (sessionId: string, ts: string): FeedEvent => ({
  ts,
  icon: '🤖',
  actor: 'you',
  text: 'started /do-review session',
  mine: true,
  avatar: me,
  sessionId,
})
const report = (ts: string, extra: Partial<FeedEvent>): FeedEvent => ({
  ts,
  icon: '📄',
  actor: 'Lookout',
  text: 'Review done',
  mine: true,
  avatar: { emoji: '👀', badge: 'me' },
  ...extra,
})

describe('linkReports', () => {
  it('quotes the exact session a captured report came from', () => {
    const [a, , r] = linkReports([
      session('s1', '2026-01-01T10:00:00Z'),
      session('s2', '2026-01-01T11:00:00Z'),
      report('2026-01-01T12:00:00Z', { body: 'x', fromSession: 's1' }),
    ])
    expect(r.replyTo).toEqual({ text: a.text, ts: a.ts, exact: true })
  })

  it('quotes the latest session before a report file, as a guess', () => {
    const [, b, r] = linkReports([
      session('s1', '2026-01-01T10:00:00Z'),
      session('s2', '2026-01-01T11:00:00Z'),
      report('2026-01-01T12:00:00Z', { filePath: '/r.md', text: 'Review done' }),
      session('s3', '2026-01-01T13:00:00Z'),
    ])
    expect(r.replyTo).toEqual({ text: b.text, ts: b.ts, exact: false })
  })

  it('quotes nothing when no session came before the report', () => {
    const [r] = linkReports([
      report('2026-01-01T09:00:00Z', { filePath: '/r.md' }),
      session('s1', '2026-01-01T10:00:00Z'),
    ])
    expect(r.replyTo).toBeUndefined()
  })

  it('leaves a captured report unquoted when its session is not on the card', () => {
    const [, r] = linkReports([
      session('s1', '2026-01-01T10:00:00Z'),
      report('2026-01-01T12:00:00Z', { body: 'x', fromSession: 'gone' }),
    ])
    expect(r.replyTo).toBeUndefined()
  })
})

describe('mergeReports', () => {
  const push = (ts: string): FeedEvent => ({
    ts,
    icon: '📦',
    actor: 'bob',
    text: 'pushed',
    mine: false,
    avatar: { login: 'bob' },
  })

  it('adds a report missing from the feed, in time order, quoting its session', () => {
    const s = session('s1', '2026-01-01T10:00:00Z')
    const out = mergeReports([s, push('2026-01-01T12:00:00Z')], [report('2026-01-01T11:00:00Z', { filePath: '/r.md' })])
    expect(out.map((e) => e.ts)).toEqual(['2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z'])
    expect(out[1].replyTo).toEqual({ text: s.text, ts: s.ts, exact: false })
  })

  it('replaces the reports already on the feed instead of doubling them', () => {
    const old = report('2026-01-01T11:00:00Z', { filePath: '/r.md' })
    const out = mergeReports([push('2026-01-01T10:00:00Z'), old], [old, report('2026-01-01T12:00:00Z', { body: 'x' })])
    expect(out.filter((e) => e.actor === 'Lookout')).toHaveLength(2)
    expect(out).toHaveLength(3)
  })

  it('drops a report that is gone from the store', () => {
    const out = mergeReports([push('2026-01-01T10:00:00Z'), report('2026-01-01T11:00:00Z', { body: 'x' })], [])
    expect(out.map((e) => e.actor)).toEqual(['bob'])
  })
})
