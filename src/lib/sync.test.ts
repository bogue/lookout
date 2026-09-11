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
import { allTasks, setPrState, setStage } from './db'
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
