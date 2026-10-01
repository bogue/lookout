import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WATCHERS,
  dueWatchers,
  matchesOf,
  parseWatcherCards,
  readWatchers,
  type Watcher,
  type WatchFacts,
  watcherKey,
  watcherPrompt,
} from './streamwatchers'

const watcher = (over: Partial<Watcher> = {}): Watcher => ({
  id: 'w1',
  name: 'Review requested',
  enabled: true,
  every: 15,
  repo: null,
  check: 'review_requested',
  templateId: 'review-cycle',
  prompt: '',
  model: 'haiku',
  tools: '',
  ...over,
})

const task = (over: Record<string, unknown> = {}) => ({
  id: 'owner/app#2',
  repo: 'owner/app',
  prNumber: 2,
  prTitle: 'Fix login',
  prState: 'open',
  isDraft: false,
  reviewRequested: true,
  ...over,
})

const facts = (over: Partial<WatchFacts> = {}): WatchFacts => ({
  tasks: [],
  myPrs: [],
  alerts: [],
  ...over,
})

describe('dueWatchers', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z')

  it('runs an enabled watcher that never ran, or whose interval passed', () => {
    const ws = [watcher({ id: 'a' }), watcher({ id: 'b' }), watcher({ id: 'c', enabled: false })]
    const last = { b: '2026-10-01T11:50:00.000Z' } // 10 min ago, every 15
    expect(dueWatchers(ws, last, now).map((w) => w.id)).toEqual(['a'])
    expect(dueWatchers(ws, { b: '2026-10-01T11:40:00.000Z' }, now).map((w) => w.id)).toEqual(['a', 'b'])
  })
})

describe('matchesOf', () => {
  it('review requested: an open, non-draft PR asking my review', () => {
    const f = facts({
      tasks: [
        task(),
        task({ id: 'owner/app#3', prNumber: 3, isDraft: true }),
        task({ id: 'owner/app#4', prNumber: 4, prState: 'merged' }),
        task({ id: 'owner/app#5', prNumber: 5, reviewRequested: false }),
      ] as never,
    })
    expect(matchesOf(watcher(), f)).toEqual([
      { ref: 'owner/app#2', repo: 'owner/app', number: 2, title: 'Fix login', event: 'requested' },
    ])
  })

  it('author pushed: one per addressed alert, the alert key as the event', () => {
    const f = facts({
      tasks: [task()] as never,
      alerts: [{ key: 'addressed:owner/app#2:2026-10-01T10:00:00Z', kind: 'addressed', taskId: 'owner/app#2' }],
    })
    expect(matchesOf(watcher({ check: 'author_pushed' }), f)).toEqual([
      {
        ref: 'owner/app#2',
        repo: 'owner/app',
        number: 2,
        title: 'Fix login',
        event: 'addressed:owner/app#2:2026-10-01T10:00:00Z',
      },
    ])
  })

  it('my PR reviewed and my CI red read the alerts of my own PRs', () => {
    const mine = [{ id: 'me/tool#7', repo: 'me/tool', number: 7, title: 'Add cache', state: 'open' }]
    const f = facts({
      myPrs: mine as never,
      alerts: [
        { key: 'awaiting_me:me/tool#7:2026-10-01T10:00:00Z', kind: 'awaiting_me', taskId: 'me/tool#7' },
        { key: 'ci_fail:me/tool#7', kind: 'ci_fail', taskId: 'me/tool#7' },
        { key: 'ci_fail:owner/app#2', kind: 'ci_fail', taskId: 'owner/app#2' }, // someone else's PR
      ],
    })
    expect(matchesOf(watcher({ check: 'my_pr_reviewed' }), f).map((m) => m.ref)).toEqual(['me/tool#7'])
    expect(matchesOf(watcher({ check: 'my_pr_ci_red' }), f).map((m) => m.ref)).toEqual(['me/tool#7'])
  })

  it('keeps to its project when it has one', () => {
    const f = facts({ tasks: [task(), task({ id: 'acme/api#9', repo: 'acme/api', prNumber: 9 })] as never })
    expect(matchesOf(watcher({ repo: 'acme/api' }), f).map((m) => m.ref)).toEqual(['acme/api#9'])
  })
})

describe('watcherKey', () => {
  it('names the watcher, the PR and the event, so the same event never makes two cards', () => {
    expect(watcherKey(watcher(), { ref: 'owner/app#2', event: 'requested' } as never)).toBe('w1|owner/app#2|requested')
  })
})

describe('readWatchers', () => {
  it('ships the four watchers, all off', () => {
    expect(readWatchers(undefined)).toEqual(DEFAULT_WATCHERS)
    expect(DEFAULT_WATCHERS.map((w) => w.check)).toEqual([
      'review_requested',
      'author_pushed',
      'my_pr_reviewed',
      'my_pr_ci_red',
    ])
    expect(DEFAULT_WATCHERS.every((w) => !w.enabled)).toBe(true)
  })

  it('drops broken stored watchers and clamps the interval', () => {
    expect(
      readWatchers([
        { id: 'x', name: 'X', enabled: true, every: 0, repo: null, check: 'review_requested', templateId: null },
        { id: 'y', name: 'Y', check: 'nope' },
      ]),
    ).toEqual([
      {
        id: 'x',
        name: 'X',
        enabled: true,
        every: 1,
        repo: null,
        check: 'review_requested',
        templateId: null,
        prompt: '',
        model: 'haiku',
        tools: '',
      },
    ])
  })

  it('keeps a prompt watcher only when it has a prompt', () => {
    const base = {
      id: 'p',
      name: 'Sentry',
      enabled: true,
      every: 30,
      check: 'prompt',
      model: 'sonnet',
      tools: 'mcp__sentry',
    }
    expect(readWatchers([{ ...base, prompt: 'new crashes?' }])[0]).toMatchObject({
      check: 'prompt',
      prompt: 'new crashes?',
      model: 'sonnet',
      tools: 'mcp__sentry',
    })
    expect(readWatchers([{ ...base, prompt: '  ' }])).toEqual([])
  })
})

describe('watcherPrompt', () => {
  it('asks for cards as JSON, with stable keys, and lists what it already made', () => {
    const p = watcherPrompt(watcher({ check: 'prompt', prompt: 'Any new Sentry crash?', repo: 'owner/app' }), [
      { key: 'SENTRY-1', title: 'Fix crash in login' },
    ])
    expect(p).toContain('Any new Sentry crash?')
    expect(p).toContain('owner/app')
    expect(p).toContain('SENTRY-1')
    expect(p).toContain('"cards"')
    expect(p).toMatch(/change nothing/i)
  })
})

describe('parseWatcherCards', () => {
  it('reads the cards out of the JSON block', () => {
    const text =
      'Found one.\n```json\n{"cards":[{"key":"S-9","title":"Fix crash","notes":"stack: x","ref":"owner/app#4"}]}\n```'
    expect(parseWatcherCards(text, 'owner/app')).toEqual([
      { key: 'S-9', title: 'Fix crash', notes: 'stack: x', repo: 'owner/app', ref: 'owner/app#4' },
    ])
  })

  it("takes a card's own project, keys a card without one by its title, drops untitled ones", () => {
    const text = '{"cards":[{"title":"Bump deps","repo":"acme/api"},{"key":"x"}]}'
    expect(parseWatcherCards(text, null)).toEqual([
      { key: 'Bump deps', title: 'Bump deps', notes: null, repo: 'acme/api', ref: null },
    ])
  })

  it('is no cards for nothing found, or an answer it cannot read', () => {
    expect(parseWatcherCards('{"cards":[]}', null)).toEqual([])
    expect(parseWatcherCards('nothing new today', null)).toEqual([])
  })
})
