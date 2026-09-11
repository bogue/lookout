import { describe, expect, it } from 'vitest'
import type { MyPr, ReviewTask } from '../types'
import {
  inScope,
  lastHumanReview,
  MY_PR_ALERT_KINDS,
  myLastWordAt,
  myPrAlerts,
  reviewFileTs,
  TASK_ALERT_KINDS,
  taskAlerts,
  workCommitsAfter,
} from './alerts'
import type { GhCommit, PrExchange } from './gh'

const ME = 'me'

const commit = (over: Partial<GhCommit> = {}): GhCommit => ({
  authoredDate: '2026-08-20T10:00:00Z',
  committedDate: '2026-08-20T10:00:00Z',
  messageHeadline: 'fix: the thing',
  authors: [{ login: 'author', name: 'The Author' }],
  ...over,
})

const exchange = (over: Partial<PrExchange> = {}): PrExchange => ({
  count: 0,
  ciState: null,
  reviews: [],
  comments: [],
  commits: [],
  ...over,
})

const task = (over: Partial<ReviewTask> = {}): ReviewTask => ({
  id: 'o/r#1',
  repo: 'o/r',
  repoPath: '/r',
  branch: 'topic',
  prNumber: 1,
  prTitle: 'A PR',
  prUrl: 'https://x',
  prState: 'open',
  prAuthor: 'author',
  prCreatedAt: '2026-08-01T00:00:00Z',
  isDraft: false,
  stage: 'reviewed',
  reviewRequested: false,
  sessionIds: [],
  reviewFiles: [],
  followupSummary: null,
  activityCount: null,
  ciState: null,
  hasNewActivity: false,
  snoozed: false,
  seen: true,
  sortOrder: null,
  doneAt: null,
  updatedAt: '2026-08-20T00:00:00Z',
  ...over,
})

const myPr = (over: Partial<MyPr> = {}): MyPr => ({
  id: 'o/r#9',
  repo: 'o/r',
  repoPath: '/r',
  number: 9,
  title: 'My PR',
  url: 'https://x',
  branch: 'mine',
  createdAt: '2026-08-01T00:00:00Z',
  state: 'open',
  isDraft: false,
  sortOrder: null,
  column: 'in_review',
  derivedColumn: 'in_review',
  humanReview: 'commented',
  botReview: null,
  ciState: null,
  doneAt: null,
  ...over,
})

describe('myLastWordAt', () => {
  it('takes the latest of my reviews and comments', () => {
    const x = exchange({
      reviews: [{ author: { login: ME }, state: 'COMMENTED', submittedAt: '2026-08-10T00:00:00Z' }],
      comments: [{ author: { login: ME }, createdAt: '2026-08-12T00:00:00Z' }],
    })
    expect(myLastWordAt(x, ME)).toBe('2026-08-12T00:00:00Z')
  })

  it('ignores other people', () => {
    const x = exchange({ comments: [{ author: { login: 'someone' }, createdAt: '2026-08-12T00:00:00Z' }] })
    expect(myLastWordAt(x, ME)).toBe('')
  })
})

describe('workCommitsAfter', () => {
  const after = '2026-08-15T00:00:00Z'

  it('keeps real commits pushed after the cutoff', () => {
    const c = commit({ authoredDate: '2026-08-16T00:00:00Z' })
    expect(workCommitsAfter([c], after, ME, false)).toEqual([c])
  })

  it('drops merge commits', () => {
    const merges = [
      commit({ authoredDate: '2026-08-16T00:00:00Z', messageHeadline: "Merge branch 'main' into topic" }),
      commit({ authoredDate: '2026-08-16T00:00:00Z', messageHeadline: 'Merge pull request #12 from x/y' }),
      commit({ authoredDate: '2026-08-16T00:00:00Z', messageHeadline: 'Merge remote-tracking branch origin/main' }),
    ]
    expect(workCommitsAfter(merges, after, ME, false)).toEqual([])
  })

  it('drops rebased work that predates the cutoff (authoredDate survives the replay)', () => {
    const rebased = commit({ authoredDate: '2026-08-01T00:00:00Z', committedDate: '2026-08-20T00:00:00Z' })
    expect(workCommitsAfter([rebased], after, ME, false)).toEqual([])
  })

  it('filters by authorship', () => {
    const theirs = commit({ authoredDate: '2026-08-16T00:00:00Z' })
    const mine = commit({ authoredDate: '2026-08-16T00:00:00Z', authors: [{ login: ME }] })
    expect(workCommitsAfter([theirs, mine], after, ME, false)).toEqual([theirs])
    expect(workCommitsAfter([theirs, mine], after, ME, true)).toEqual([mine])
  })
})

describe('taskAlerts — the author addressed my review', () => {
  const x = exchange({
    comments: [{ author: { login: ME }, createdAt: '2026-08-15T00:00:00Z' }],
    commits: [commit({ authoredDate: '2026-08-16T00:00:00Z' }), commit({ authoredDate: '2026-08-17T00:00:00Z' })],
  })

  it('alerts with the newest commit as the key', () => {
    const [a] = taskAlerts(task(), x, ME)
    expect(a.kind).toBe('addressed')
    expect(a.key).toBe('addressed:o/r#1:2026-08-17T00:00:00Z')
    expect(a.body).toContain('2 new commits')
  })

  it('stays quiet when the only push is a merge of the base branch', () => {
    const merged = exchange({
      comments: x.comments,
      commits: [commit({ authoredDate: '2026-08-16T00:00:00Z', messageHeadline: "Merge branch 'main'" })],
    })
    expect(taskAlerts(task(), merged, ME)).toEqual([])
  })

  it('stays quiet when nothing was pushed since my comment', () => {
    expect(taskAlerts(task(), exchange({ comments: x.comments }), ME)).toEqual([])
  })

  it('drops the alert once the PR is merged or the card is done', () => {
    expect(taskAlerts(task({ prState: 'merged' }), x, ME)).toEqual([])
    expect(taskAlerts(task({ stage: 'done' }), x, ME)).toEqual([])
  })
})

describe('taskAlerts — my review is done but unsent', () => {
  it('alerts when a report exists and I said nothing on GitHub', () => {
    const t = task({ stage: 'reviewed', reviewFiles: ['/r/AI_TASKS/code-review/2026-08-20-09-30-topic.md'] })
    const [a] = taskAlerts(t, exchange(), ME)
    expect(a.kind).toBe('ready_to_send')
    expect(a.key).toBe(`ready_to_send:o/r#1:${reviewFileTs(t.reviewFiles[0])}`)
  })

  it('does not alert while the review session hasn’t produced anything', () => {
    expect(taskAlerts(task({ stage: 'watching' }), exchange(), ME)).toEqual([])
  })

  it('yields to the addressed rule once I have spoken', () => {
    const t = task({ reviewFiles: ['/r/AI_TASKS/code-review/2026-08-20-09-30-topic.md'] })
    const x = exchange({
      reviews: [{ author: { login: ME }, state: 'COMMENTED', submittedAt: '2026-08-21T00:00:00Z' }],
    })
    expect(taskAlerts(t, x, ME)).toEqual([])
  })
})

describe('taskAlerts — CI', () => {
  it('adds a single keyless ci_fail alert while red', () => {
    const alerts = taskAlerts(task({ stage: 'watching' }), exchange({ ciState: 'fail' }), ME)
    expect(alerts.map((a) => a.key)).toEqual(['ci_fail:o/r#1'])
  })

  it('drops it when CI is green', () => {
    expect(taskAlerts(task({ stage: 'watching' }), exchange({ ciState: 'pass' }), ME)).toEqual([])
  })
})

describe('myPrAlerts', () => {
  const review = { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-08-15T00:00:00Z' }

  it('alerts when a human reviewed and I have not pushed since', () => {
    const [a] = myPrAlerts(myPr(), exchange({ reviews: [review] }), ME)
    expect(a.kind).toBe('awaiting_me')
    expect(a.title).toBe('reviewer reviewed your PR')
    expect(a.body).toContain('changes requested')
  })

  it('clears once I push real work', () => {
    const x = exchange({
      reviews: [review],
      commits: [commit({ authoredDate: '2026-08-16T00:00:00Z', authors: [{ login: ME }] })],
    })
    expect(myPrAlerts(myPr(), x, ME)).toEqual([])
  })

  it('keeps alerting when my only push is a merge of main', () => {
    const x = exchange({
      reviews: [review],
      commits: [
        commit({
          authoredDate: '2026-08-16T00:00:00Z',
          authors: [{ login: ME }],
          messageHeadline: "Merge branch 'main' into mine",
        }),
      ],
    })
    expect(myPrAlerts(myPr(), x, ME)).toHaveLength(1)
  })

  it('ignores bot reviews', () => {
    const x = exchange({
      reviews: [{ author: { login: 'sonarcloud[bot]' }, state: 'COMMENTED', submittedAt: '2026-08-15T00:00:00Z' }],
    })
    expect(myPrAlerts(myPr(), x, ME)).toEqual([])
  })

  it('ignores my own review of my PR', () => {
    const x = exchange({
      reviews: [{ author: { login: ME }, state: 'COMMENTED', submittedAt: '2026-08-15T00:00:00Z' }],
    })
    expect(myPrAlerts(myPr(), x, ME)).toEqual([])
  })

  it('says nothing about a merged PR', () => {
    expect(myPrAlerts(myPr({ state: 'merged' }), exchange({ reviews: [review] }), ME)).toEqual([])
  })
})

describe('lastHumanReview', () => {
  it('returns the newest non-bot, non-mine review', () => {
    const reviews = [
      { author: { login: 'a' }, state: 'COMMENTED', submittedAt: '2026-08-10T00:00:00Z' },
      { author: { login: 'b' }, state: 'APPROVED', submittedAt: '2026-08-14T00:00:00Z' },
      { author: { login: 'bot[bot]' }, state: 'COMMENTED', submittedAt: '2026-08-20T00:00:00Z' },
    ]
    expect(lastHumanReview(reviews, ME)?.author?.login).toBe('b')
  })
})

describe('inScope — what a pass may delete', () => {
  const row = { taskId: 'o/r#1', kind: 'addressed' } as const

  it('deletes a kind it derives, in a repo it polled', () => {
    expect(inScope(row, { kinds: TASK_ALERT_KINDS, repos: ['o/r'] })).toBe(true)
  })

  it('spares a repo that failed to poll', () => {
    expect(inScope(row, { kinds: TASK_ALERT_KINDS, repos: ['other/repo'] })).toBe(false)
  })

  it('spares kinds owned by the other sync pass', () => {
    expect(inScope({ taskId: 'o/r#9', kind: 'awaiting_me' }, { kinds: TASK_ALERT_KINDS, repos: ['o/r'] })).toBe(false)
    expect(inScope(row, { kinds: MY_PR_ALERT_KINDS, repos: ['o/r'] })).toBe(false)
  })

  it('supports a single-task scope for the on-demand refresh', () => {
    expect(inScope(row, { kinds: TASK_ALERT_KINDS, taskIds: ['o/r#1'] })).toBe(true)
    expect(inScope(row, { kinds: TASK_ALERT_KINDS, taskIds: ['o/r#2'] })).toBe(false)
  })
})
