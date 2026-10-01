import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewTask } from '../types'

vi.mock('./config', () => ({
  getConfig: vi.fn(),
  setGithubUser: vi.fn(),
  setGithubName: vi.fn(),
}))
vi.mock('./db', () => ({
  allTasks: vi.fn(),
  capturedCliTaskIds: vi.fn(async () => new Set<string>()),
  deleteCapturedReview: vi.fn(),
  pruneCapturedReviews: vi.fn(),
  pruneRepos: vi.fn(),
  setActivity: vi.fn(),
  setLinks: vi.fn(),
  setPrState: vi.fn(),
  setApproved: vi.fn(),
  setSnoozed: vi.fn(),
  setStage: vi.fn(),
  syncAlerts: vi.fn(async () => []),
  upsertCapturedReview: vi.fn(),
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
vi.mock('./classify', () => ({ classifySession: vi.fn() }))
vi.mock('./reviews', () => ({ scanReviewFiles: vi.fn() }))
vi.mock('./sessions', () => ({
  scanRepoSessions: vi.fn(),
  scanRepoReviewSessions: vi.fn(async () => []),
  captureKind: (s: { command: string | null }) => (s.command === 'do-followup' ? 'followup' : 'review'),
  transcriptPath: vi.fn(
    async (cwd: string, id: string) => `/home/.claude/projects/${cwd.replace(/\//g, '-')}/${id}.jsonl`,
  ),
}))
vi.mock('./capture', () => ({ captureIfGrown: vi.fn(), captureFromTranscript: vi.fn() }))

import { captureFromTranscript, captureIfGrown } from './capture'
import { classifySession } from './classify'
import { getConfig } from './config'
import {
  allTasks,
  capturedCliTaskIds,
  deleteCapturedReview,
  pruneCapturedReviews,
  setApproved,
  setPrState,
  setStage,
  upsertCapturedReview,
  upsertPr,
} from './db'
import { fetchPrState, listCommentedByMe, listOpenPrs } from './gh'
import { scanReviewFiles } from './reviews'
import { scanRepoReviewSessions, scanRepoSessions } from './sessions'
import { captureRun, syncAll } from './sync'

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
  ciChecks: null,
  conflicts: false,
  approved: false,
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
      captureReviews: false,
      openInBrowser: false,
      notifications: true,
      mergeMethod: 'merge',
      streamAutoRun: false,
      streamTemplates: [],
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
    vi.mocked(fetchPrState).mockResolvedValue({ state: 'merged', approved: false })

    await syncAll()

    expect(fetchPrState).toHaveBeenCalledWith(REPO, 1)
    expect(setPrState).toHaveBeenCalledWith(done.id, 'merged')
    // already in Done: don't touch the stage
    expect(setStage).not.toHaveBeenCalled()
  })

  it('still clears a non-Done card to Done when its PR merges', async () => {
    const active = task({ stage: 'reviewing', prState: 'open' })
    vi.mocked(allTasks).mockResolvedValue([active])
    vi.mocked(fetchPrState).mockResolvedValue({ state: 'merged', approved: false })

    await syncAll()

    expect(setPrState).toHaveBeenCalledWith(active.id, 'merged')
    expect(setStage).toHaveBeenCalledWith(active.id, 'done')
  })

  // approved then merged between two syncs: the open-PR listing never saw the approval
  it('records an approval that landed just before the merge', async () => {
    const active = task({ stage: 'reviewed', prState: 'open' })
    vi.mocked(allTasks).mockResolvedValue([active])
    vi.mocked(fetchPrState).mockResolvedValue({ state: 'merged', approved: true })

    await syncAll()

    expect(setApproved).toHaveBeenCalledWith(active.id, true)
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
      captureReviews: false,
      openInBrowser: false,
      notifications: true,
      mergeMethod: 'merge',
      streamAutoRun: false,
      streamTemplates: [],
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
  it('flags a PR a human reviewer approved', async () => {
    vi.mocked(listOpenPrs).mockResolvedValue([
      { ...theirPr, latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }] },
    ])

    await syncAll()

    expect(upsertPr).toHaveBeenCalledWith(expect.objectContaining({ id: `${REPO}#2`, approved: true }))
  })
})

describe('syncAll — capturing a review the session never exported', () => {
  const openPr = {
    number: 7,
    title: 'A PR',
    url: `https://github.com/${REPO}/pull/7`,
    headRefName: 'feature',
    author: { login: 'someone' },
    createdAt: '2026-09-18T00:00:00Z',
    isDraft: false,
    reviewRequests: [],
    latestReviews: [],
  }
  const session = {
    sessionId: 's1',
    command: 'review',
    branch: 'feature' as string | null,
    prNumber: null as number | null,
    ts: '2026-09-18T10:00:00Z',
    cwd: '/clone',
    path: '/home/.claude/projects/-clone/s1.jsonl',
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
      captureReviews: true,
      openInBrowser: false,
      notifications: true,
      mergeMethod: 'merge',
      streamAutoRun: false,
      streamTemplates: [],
    })
    vi.mocked(allTasks).mockResolvedValue([])
    vi.mocked(listOpenPrs).mockResolvedValue([openPr] as unknown as Awaited<ReturnType<typeof listOpenPrs>>)
    vi.mocked(listCommentedByMe).mockResolvedValue(new Set())
    vi.mocked(scanRepoSessions).mockResolvedValue(new Map())
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map())
    vi.mocked(scanRepoReviewSessions).mockResolvedValue([session])
    vi.mocked(capturedCliTaskIds).mockResolvedValue(new Set())
    vi.mocked(pruneCapturedReviews).mockResolvedValue(undefined)
    vi.mocked(captureIfGrown).mockResolvedValue({ kind: 'captured', body: 'the review', ts: '2026-09-18T10:05:00Z' })
  })

  it('stores the captured review against the card', async () => {
    await syncAll()
    expect(upsertCapturedReview).toHaveBeenCalledWith({
      id: 's1',
      kind: 'review',
      taskId: `${REPO}#7`,
      branch: 'feature',
      source: 'sync',
      sessionId: 's1',
      filePath: null,
      body: 'the review',
      createdAt: '2026-09-18T10:05:00Z',
    })
  })

  it('leaves a branch alone when the skill already exported a report', async () => {
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map([['feature', ['/clone/AI_TASKS/code-review/x.md']]]))
    await syncAll()
    expect(captureIfGrown).not.toHaveBeenCalled()
    expect(upsertCapturedReview).not.toHaveBeenCalled()
  })

  // captured mid-run, before the session got round to writing its report
  it('drops a capture once the branch turns out to export reports', async () => {
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map([['feature', ['/clone/AI_TASKS/code-review/x.md']]]))
    await syncAll()
    expect(deleteCapturedReview).toHaveBeenCalledWith('s1')
  })

  it('drops a capture once the transcript shows the session exported one', async () => {
    vi.mocked(captureIfGrown).mockResolvedValue({ kind: 'exported' })
    await syncAll()
    expect(deleteCapturedReview).toHaveBeenCalledWith('s1')
    expect(upsertCapturedReview).not.toHaveBeenCalled()
  })

  it('stands aside for a card a skill registered a review for', async () => {
    vi.mocked(capturedCliTaskIds).mockResolvedValue(new Set([`${REPO}#7`]))
    await syncAll()
    expect(captureIfGrown).not.toHaveBeenCalled()
    expect(upsertCapturedReview).not.toHaveBeenCalled()
    expect(deleteCapturedReview).not.toHaveBeenCalled()
  })

  it('does not let a failing retention sweep take the pass down with it', async () => {
    vi.mocked(pruneCapturedReviews).mockRejectedValue(new Error('database is locked'))
    await expect(syncAll()).resolves.toBeDefined()
    expect(upsertPr).toHaveBeenCalled()
  })

  it('does nothing at all when capture is switched off', async () => {
    const config = await vi.mocked(getConfig)()
    vi.mocked(getConfig).mockResolvedValue({ ...config, captureReviews: false })
    await syncAll()
    expect(scanRepoReviewSessions).not.toHaveBeenCalled()
    expect(upsertCapturedReview).not.toHaveBeenCalled()
  })

  it('captures a follow-up on a branch that exports review reports', async () => {
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map([['feature', ['/clone/AI_TASKS/code-review/x.md']]]))
    vi.mocked(scanRepoReviewSessions).mockResolvedValue([{ ...session, command: 'do-followup' }])
    await syncAll()
    expect(upsertCapturedReview).toHaveBeenCalledWith(expect.objectContaining({ kind: 'followup' }))
  })

  it('labels a follow-up run as a follow-up, not a second review', async () => {
    vi.mocked(scanRepoReviewSessions).mockResolvedValue([{ ...session, command: 'do-followup' }])
    await syncAll()
    expect(upsertCapturedReview).toHaveBeenCalledWith(expect.objectContaining({ kind: 'followup' }))
  })

  it('places a session that named a PR id on that card, with the card own branch', async () => {
    vi.mocked(scanRepoReviewSessions).mockResolvedValue([{ ...session, branch: null, prNumber: 7 }])
    await syncAll()
    expect(upsertCapturedReview).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: `${REPO}#7`, branch: 'feature' }),
    )
  })

  it('ignores a session whose PR is not on the board', async () => {
    vi.mocked(scanRepoReviewSessions).mockResolvedValue([{ ...session, branch: null, prNumber: 999 }])
    await syncAll()
    expect(upsertCapturedReview).not.toHaveBeenCalled()
  })

  it('ignores a session whose branch has no PR on the board', async () => {
    vi.mocked(scanRepoReviewSessions).mockResolvedValue([{ ...session, branch: 'some-other-branch' }])
    await syncAll()
    expect(upsertCapturedReview).not.toHaveBeenCalled()
  })
})

describe('captureRun — a button run whose turn just finished', () => {
  const run = {
    taskId: `${REPO}#7`,
    branch: 'feature',
    repoPath: '/clone',
    cwd: '/wt/feature',
    sessionId: 's9',
    kind: 'followup' as 'review' | 'followup' | null,
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
      captureReviews: true,
      openInBrowser: false,
      notifications: true,
      mergeMethod: 'merge',
      streamAutoRun: false,
      streamTemplates: [],
    })
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map())
    vi.mocked(capturedCliTaskIds).mockResolvedValue(new Set())
    vi.mocked(captureFromTranscript).mockResolvedValue({
      kind: 'captured',
      body: 'the verdict',
      ts: '2026-09-25T10:00:00Z',
    })
  })

  it('stores the run final turn with the kind its button declared', async () => {
    await captureRun(run)
    expect(captureFromTranscript).toHaveBeenCalledWith('/home/.claude/projects/-wt-feature/s9.jsonl')
    expect(upsertCapturedReview).toHaveBeenCalledWith({
      id: 's9',
      kind: 'followup',
      taskId: `${REPO}#7`,
      branch: 'feature',
      source: 'sync',
      sessionId: 's9',
      filePath: null,
      body: 'the verdict',
      createdAt: '2026-09-25T10:00:00Z',
    })
  })

  it('leaves a review alone on a branch that exports its own reports', async () => {
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map([['feature', ['/clone/AI_TASKS/code-review/x.md']]]))
    await captureRun({ ...run, kind: 'review' })
    expect(upsertCapturedReview).not.toHaveBeenCalled()
    expect(deleteCapturedReview).toHaveBeenCalledWith('s9')
  })

  // /do-review exports a report file, /do-followup doesn't: the file is a review, not this follow-up
  it('still stores a follow-up on a branch that exports review reports', async () => {
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map([['feature', ['/clone/AI_TASKS/code-review/x.md']]]))
    await captureRun(run)
    expect(upsertCapturedReview).toHaveBeenCalledWith(expect.objectContaining({ id: 's9', kind: 'followup' }))
  })

  it('stands aside for a card a skill registered a review for', async () => {
    vi.mocked(capturedCliTaskIds).mockResolvedValue(new Set([`${REPO}#7`]))
    await captureRun(run)
    expect(captureFromTranscript).not.toHaveBeenCalled()
  })

  it('does nothing when capture is switched off', async () => {
    const config = await vi.mocked(getConfig)()
    vi.mocked(getConfig).mockResolvedValue({ ...config, captureReviews: false })
    await captureRun(run)
    expect(captureFromTranscript).not.toHaveBeenCalled()
  })

  it('asks Haiku when the prompt did not say what the run was', async () => {
    vi.mocked(classifySession).mockResolvedValue('followup')
    await captureRun({ ...run, kind: null })
    expect(classifySession).toHaveBeenCalledWith('s9', 'the verdict')
    expect(upsertCapturedReview).toHaveBeenCalledWith(expect.objectContaining({ id: 's9', kind: 'followup' }))
  })

  it('stores nothing when Haiku says the run was not a review', async () => {
    vi.mocked(classifySession).mockResolvedValue(null)
    await captureRun({ ...run, kind: null })
    expect(upsertCapturedReview).not.toHaveBeenCalled()
  })

  it('does not ask Haiku when the slash command already said', async () => {
    await captureRun(run)
    expect(classifySession).not.toHaveBeenCalled()
  })

  it('drops what Haiku calls a review on a branch that exports its own reports', async () => {
    vi.mocked(scanReviewFiles).mockResolvedValue(new Map([['feature', ['/clone/AI_TASKS/code-review/x.md']]]))
    vi.mocked(classifySession).mockResolvedValue('review')
    await captureRun({ ...run, kind: null })
    expect(upsertCapturedReview).not.toHaveBeenCalled()
    expect(deleteCapturedReview).toHaveBeenCalledWith('s9')
  })
})
