import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewTask } from '../types'

vi.mock('./config', () => ({
  getConfig: vi.fn(),
  setGithubUser: vi.fn(),
  setGithubName: vi.fn(),
}))
vi.mock('./db', () => ({
  allTasks: vi.fn(),
  pruneRepos: vi.fn(),
  setActivity: vi.fn(),
  setLinks: vi.fn(),
  setPrState: vi.fn(),
  setSnoozed: vi.fn(),
  setStage: vi.fn(),
  syncAlerts: vi.fn(async () => []),
  upsertPr: vi.fn(),
}))
vi.mock('./gh', () => ({
  fetchLogin: vi.fn(),
  fetchName: vi.fn(),
  fetchPrExchange: vi.fn(async () => ({ count: 0, ciState: null, reviews: [], comments: [], commits: [] })),
  fetchPrState: vi.fn(),
  listCommentedByMe: vi.fn(),
  listOpenPrs: vi.fn(),
}))
vi.mock('./notify', () => ({ notify: vi.fn() }))
vi.mock('./reviews', () => ({ scanReviewFiles: vi.fn() }))
vi.mock('./sessions', () => ({ scanRepoSessions: vi.fn() }))

import { getConfig } from './config'
import { allTasks, setPrState, setStage, upsertPr } from './db'
import { fetchPrState, listCommentedByMe, listOpenPrs } from './gh'
import { scanReviewFiles } from './reviews'
import { scanRepoSessions } from './sessions'
import { syncAll } from './sync'

const REPO = 'owner/repo'

const task = (overrides: Partial<ReviewTask>): ReviewTask => ({
  id: `${REPO}#1`,
  repo: REPO,
  repoPath: '/clone',
  branch: 'feature',
  prNumber: 1,
  prTitle: 'A PR',
  prUrl: `https://github.com/${REPO}/pull/1`,
  prState: 'open',
  prAuthor: 'someone',
  prCreatedAt: '2026-07-01T00:00:00Z',
  isDraft: false,
  stage: 'reviewing',
  reviewRequested: false,
  sessionIds: [],
  reviewFiles: [],
  followupSummary: null,
  activityCount: null,
  ciState: null,
  hasNewActivity: false,
  snoozed: false,
  seen: false,
  sortOrder: null,
  doneAt: null,
  updatedAt: '2026-07-01T00:00:00Z',
  ...overrides,
})

describe('syncAll — PR state reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getConfig).mockResolvedValue({
      githubUser: 'me',
      repos: [{ repo: REPO, path: '/clone' }],
      githubName: 'Me Name',
      reviewButtons: [],
      prButtons: [],
      animations: true,
      logging: false,
    })
    // PR is no longer in the open list (it merged/closed on GitHub)
    vi.mocked(listOpenPrs).mockResolvedValue([])
    vi.mocked(scanRepoSessions).mockResolvedValue(new Map())
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map())
    vi.mocked(listCommentedByMe).mockResolvedValue(new Set())
  })

  it('reconciles a card already in Done whose PR merged (the manual-drag-to-Done case)', async () => {
    // card was manually dragged to Done while its PR was still open
    const done = task({ stage: 'done', prState: 'open', doneAt: '2026-07-02T00:00:00Z' })
    vi.mocked(allTasks).mockResolvedValue([done])
    vi.mocked(fetchPrState).mockResolvedValue('merged')

    await syncAll()

    expect(fetchPrState).toHaveBeenCalledWith(REPO, 1)
    expect(setPrState).toHaveBeenCalledWith(done.id, 'merged')
    // already in Done: don't touch the stage
    expect(setStage).not.toHaveBeenCalled()
  })

  it('still clears a non-Done card to Done when its PR merges', async () => {
    const active = task({ stage: 'reviewing', prState: 'open' })
    vi.mocked(allTasks).mockResolvedValue([active])
    vi.mocked(fetchPrState).mockResolvedValue('merged')

    await syncAll()

    expect(setPrState).toHaveBeenCalledWith(active.id, 'merged')
    expect(setStage).toHaveBeenCalledWith(active.id, 'done')
  })

  it('does not re-query a Done card whose state is already resolved', async () => {
    const done = task({ stage: 'done', prState: 'merged', doneAt: '2026-07-02T00:00:00Z' })
    vi.mocked(allTasks).mockResolvedValue([done])

    await syncAll()

    expect(fetchPrState).not.toHaveBeenCalled()
    expect(setPrState).not.toHaveBeenCalled()
  })
})

describe('syncAll — a local scan that fails', () => {
  const theirPr = {
    number: 2,
    title: 'Their PR',
    url: `https://github.com/${REPO}/pull/2`,
    headRefName: 'their-branch',
    author: { login: 'someone' },
    createdAt: '2026-09-15T13:54:23Z',
    isDraft: false,
    reviewRequests: [],
    latestReviews: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getConfig).mockResolvedValue({
      githubUser: 'me',
      repos: [{ repo: REPO, path: '/clone' }],
      githubName: 'Me Name',
      reviewButtons: [],
      prButtons: [],
      animations: true,
      logging: false,
    })
    vi.mocked(allTasks).mockResolvedValue([])
    vi.mocked(listOpenPrs).mockResolvedValue([theirPr])
    vi.mocked(listCommentedByMe).mockResolvedValue(new Set())
    vi.mocked(scanRepoSessions).mockResolvedValue(new Map())
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map())
  })

  // Both scans used to share a Promise.all with the gh calls, so an unreadable checkout rejected it
  // and skipped the upsert loop: every PR opened after that point stayed off the board for good.
  it('still boards the PRs the repo answered with when the review scan throws', async () => {
    vi.mocked(scanReviewFiles).mockRejectedValue(new Error('forbidden path: /clone/.claude/worktrees/wt'))

    await syncAll()

    expect(upsertPr).toHaveBeenCalledWith(expect.objectContaining({ id: `${REPO}#2`, prNumber: 2 }))
  })

  it('still boards them when the session scan throws', async () => {
    vi.mocked(scanRepoSessions).mockRejectedValue(new Error('Too many open files (os error 24)'))

    await syncAll()

    expect(upsertPr).toHaveBeenCalledWith(expect.objectContaining({ id: `${REPO}#2`, prNumber: 2 }))
  })
})
