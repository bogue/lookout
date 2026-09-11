import { describe, expect, it } from 'vitest'
import type { GhMyPr } from './gh'
import { isBot, reviewFlavor, rollupToCiState, toMyPr } from './prboard'

const REPO = 'owner/repo'

// a raw gh PR authored by me, open, no reviews, CI empty — override per test
const raw = (o: Partial<GhMyPr> = {}): GhMyPr => ({
  number: 1,
  title: 'My PR',
  url: `https://github.com/${REPO}/pull/1`,
  headRefName: 'feature',
  createdAt: '2026-07-01T00:00:00Z',
  isDraft: false,
  state: 'OPEN',
  latestReviews: [],
  reviewRequests: [],
  statusCheckRollup: [],
  ...o,
})

const human = (state: string, login = 'alice') => ({ author: { login }, state })
const bot = (state: string, login = 'cursor[bot]') => ({ author: { login, is_bot: true }, state })

const col = (o: Partial<GhMyPr>) => toMyPr(raw(o), REPO, '/clone').column

describe('isBot', () => {
  it('detects the [bot] login suffix', () => {
    expect(isBot({ login: 'cursor[bot]' })).toBe(true)
    expect(isBot({ login: 'alice' })).toBe(false)
  })
  it('honors the explicit is_bot flag', () => {
    expect(isBot({ login: 'weird-name', is_bot: true })).toBe(true)
  })
  it('treats a null author as non-bot', () => {
    expect(isBot(null)).toBe(false)
  })
})

describe('reviewFlavor — changes_requested > approved > commented', () => {
  it('returns null with no reviews', () => expect(reviewFlavor([])).toBe(null))
  it('changes_requested wins over an approval from another reviewer', () =>
    expect(reviewFlavor([human('APPROVED'), human('CHANGES_REQUESTED', 'bob')])).toBe('changes_requested'))
  it('approved wins over a mere comment', () =>
    expect(reviewFlavor([human('COMMENTED'), human('APPROVED', 'bob')])).toBe('approved'))
  it('commented when only comments exist', () => expect(reviewFlavor([human('COMMENTED')])).toBe('commented'))
})

describe('rollupToCiState', () => {
  it('null when there are no checks', () => expect(rollupToCiState([])).toBe(null))
  it('fail when any check failed', () =>
    expect(rollupToCiState([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('fail'))
  it('pending when a check is still running', () =>
    expect(rollupToCiState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }])).toBe('pending'))
  it('pass when all checks succeeded', () =>
    expect(rollupToCiState([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('pass'))
})

describe('classifyColumn — column per PR state', () => {
  it('Waiting: open, no reviews yet', () => {
    expect(col({})).toBe('waiting')
  })

  it('Waiting: draft even if it somehow has a review', () => {
    expect(col({ isDraft: true, latestReviews: [human('COMMENTED')] })).toBe('waiting')
  })

  it('Done: closed without merging is dealt with too', () => {
    expect(col({ state: 'CLOSED' })).toBe('done')
  })

  it('In Review: a human requested changes', () => {
    expect(col({ latestReviews: [human('CHANGES_REQUESTED')] })).toBe('in_review')
  })

  it('In Review: a human left a comment review', () => {
    expect(col({ latestReviews: [human('COMMENTED')] })).toBe('in_review')
  })

  it('Waiting: a bot-only review does not move the card (bot review is lint, not the process)', () => {
    expect(col({ latestReviews: [bot('CHANGES_REQUESTED')] })).toBe('waiting')
    expect(col({ latestReviews: [bot('APPROVED')] })).toBe('waiting')
  })

  it('Ready: a human approved', () => {
    expect(col({ latestReviews: [human('APPROVED')] })).toBe('ready')
  })

  it('Ready: approved despite nitpick comments from another human', () => {
    expect(col({ latestReviews: [human('APPROVED'), human('COMMENTED', 'bob')] })).toBe('ready')
  })

  it('Ready: human approved even though a bot requested changes', () => {
    expect(col({ latestReviews: [human('APPROVED'), bot('CHANGES_REQUESTED')] })).toBe('ready')
  })

  it('back to In Review: latest human review is changes_requested after a prior approval', () => {
    // gh latestReviews returns the newest review per reviewer, so a re-review flips the flavor
    expect(col({ latestReviews: [human('CHANGES_REQUESTED')] })).toBe('in_review')
  })

  it('stays Ready while still approved (re-request that did not un-approve)', () => {
    expect(col({ latestReviews: [human('APPROVED')] })).toBe('ready')
  })

  it('Done: merged PR', () => {
    expect(col({ state: 'MERGED' })).toBe('done')
  })
})

// classifyColumn is only GitHub's opinion — resolveColumn (prcolumns.test.ts) is what keeps a card
// that already reached In Review from falling back here.
describe('re-requested review supersedes a prior review', () => {
  it('a commented reviewer who is re-requested no longer shows a tag → back to Waiting', () => {
    const pr = toMyPr(
      raw({ latestReviews: [human('COMMENTED', 'Mig-OG')], reviewRequests: [{ login: 'Mig-OG' }] }),
      REPO,
      '/clone',
    )
    expect(pr.humanReview).toBe(null)
    expect(pr.column).toBe('waiting')
  })

  it('without a pending request the commented tag stays and it sits In Review', () => {
    const pr = toMyPr(raw({ latestReviews: [human('COMMENTED', 'Mig-OG')] }), REPO, '/clone')
    expect(pr.humanReview).toBe('commented')
    expect(pr.column).toBe('in_review')
  })

  it('a re-requested reviewer who already approved earlier is treated as pending (not ready)', () => {
    const pr = toMyPr(
      raw({ latestReviews: [human('APPROVED', 'Mig-OG')], reviewRequests: [{ login: 'Mig-OG' }] }),
      REPO,
      '/clone',
    )
    expect(pr.humanReview).toBe(null)
    expect(pr.column).toBe('waiting')
  })
})

describe('toMyPr', () => {
  it('boards closed-unmerged PRs into Done, stamped for the midnight prune', () => {
    const pr = toMyPr(raw({ state: 'CLOSED', closedAt: '2026-09-11T10:00:00Z' }), REPO, '/clone')
    expect(pr.column).toBe('done')
    expect(pr.doneAt).toBe('2026-09-11T10:00:00Z')
  })

  it('prefers mergedAt over closedAt (a merge stamps both)', () => {
    const pr = toMyPr(
      raw({ state: 'MERGED', mergedAt: '2026-09-11T09:00:00Z', closedAt: '2026-09-11T09:00:01Z' }),
      REPO,
      '/clone',
    )
    expect(pr.doneAt).toBe('2026-09-11T09:00:00Z')
  })

  it('leaves doneAt null while the PR is open', () =>
    expect(toMyPr(raw({}), REPO, '/clone').doneAt).toBe(null))

  it('separates human and bot review tags', () => {
    const pr = toMyPr(raw({ latestReviews: [human('APPROVED'), bot('CHANGES_REQUESTED')] }), REPO, '/clone')
    expect(pr.humanReview).toBe('approved')
    expect(pr.botReview).toBe('changes_requested')
  })

  it('surfaces the CI tag and stable id', () => {
    const pr = toMyPr(raw({ number: 42, statusCheckRollup: [{ conclusion: 'FAILURE' }] }), REPO, '/clone')
    expect(pr.ciState).toBe('fail')
    expect(pr.id).toBe('owner/repo#42')
  })
})
