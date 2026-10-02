import { describe, expect, it } from 'vitest'
import type { FeedEvent } from './feed'
import { sessionOptions } from './replytarget'

const ev = (sessionId: string, icon: string, text: string, ts: string): FeedEvent => ({
  ts,
  icon,
  actor: 'you',
  text,
  mine: true,
  avatar: { login: 'me' },
  sessionId,
})

describe('sessionOptions', () => {
  it('lists the PR sessions newest first, named as the history names them', () => {
    const feed = [
      ev('s1', '🤖', 'started /do-review session', '2026-01-01T10:00:00Z'),
      { ...ev('x', '📦', 'pushed', '2026-01-01T10:30:00Z'), sessionId: undefined },
      ev('c1', '💬', 'chat: still needed?', '2026-01-01T11:00:00Z'),
      ev('s2', '🤖', 'started a claude session', '2026-01-01T12:00:00Z'),
    ]
    expect(sessionOptions(feed, undefined)).toEqual([
      { sessionId: 's2', icon: '🤖', label: 'claude session', ts: '2026-01-01T12:00:00Z' },
      { sessionId: 'c1', icon: '💬', label: 'chat: still needed?', ts: '2026-01-01T11:00:00Z' },
      { sessionId: 's1', icon: '🤖', label: '/do-review session', ts: '2026-01-01T10:00:00Z' },
    ])
  })

  // a run that just started is not in the history until it finishes
  it('puts the live run first when the history does not have it yet', () => {
    const feed = [ev('s1', '🤖', 'started /do-review session', '2026-01-01T10:00:00Z')]
    expect(sessionOptions(feed, { sessionId: 'c9', command: 'chat' })[0]).toEqual({
      sessionId: 'c9',
      icon: '💬',
      label: 'chat',
    })
    expect(sessionOptions(null, { sessionId: 'r9', command: 'Review' })).toEqual([
      { sessionId: 'r9', icon: '🤖', label: 'Review' },
    ])
  })

  it('does not list the live run twice', () => {
    const feed = [ev('s1', '🤖', 'started /do-review session', '2026-01-01T10:00:00Z')]
    expect(sessionOptions(feed, { sessionId: 's1', command: 'Review' })).toHaveLength(1)
    expect(sessionOptions(feed, { sessionId: null, command: 'chat' })).toHaveLength(1)
  })
})
