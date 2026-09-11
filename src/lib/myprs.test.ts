import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, MyPr } from '../types'
import type { GhMyPr } from './gh'

vi.mock('./config', () => ({ getConfig: vi.fn(), setGithubUser: vi.fn() }))
vi.mock('./db', () => ({
  allMyPrs: vi.fn(async () => []),
  dropMyPrsMissingFrom: vi.fn(),
  pruneDoneMyPrs: vi.fn(),
  pruneMyPrRepos: vi.fn(),
  syncAlerts: vi.fn(async () => []),
  upsertMyPr: vi.fn(),
}))
vi.mock('./gh', () => ({
  fetchLogin: vi.fn(),
  fetchPrExchange: vi.fn(async () => ({ count: 0, ciState: null, reviews: [], comments: [], commits: [] })),
  listMyPrs: vi.fn(),
}))
vi.mock('./notify', () => ({ notify: vi.fn() }))
vi.mock('./proverrides', () => ({ migrateLegacyPrStore: vi.fn(async () => ({ columns: {}, orders: {} })) }))

import { allMyPrs, dropMyPrsMissingFrom, pruneDoneMyPrs, upsertMyPr } from './db'
import { listMyPrs } from './gh'
import { syncMyPrs } from './myprs'
import { migrateLegacyPrStore } from './proverrides'

const REPO = 'owner/repo'
const OTHER = 'owner/other'

const config = (repos = [REPO, OTHER]): Config => ({
  githubUser: 'me',
  githubName: 'Me',
  repos: repos.map((repo) => ({ repo, path: `/clone/${repo}` })),
  reviewButtons: [],
  prButtons: [],
  animations: true,
  logging: false,
})

const ghPr = (o: Partial<GhMyPr> = {}): GhMyPr => ({
  number: 1,
  title: 'My PR',
  url: 'https://x',
  headRefName: 'feature',
  createdAt: '2026-09-01T00:00:00Z',
  isDraft: false,
  state: 'OPEN',
  latestReviews: [],
  reviewRequests: [],
  statusCheckRollup: [],
  ...o,
})

const storedPr = (o: Partial<MyPr> = {}): MyPr => ({
  id: `${REPO}#1`,
  repo: REPO,
  repoPath: `/clone/${REPO}`,
  number: 1,
  title: 'My PR',
  url: 'https://x',
  branch: 'feature',
  createdAt: '2026-09-01T00:00:00Z',
  state: 'open',
  isDraft: false,
  sortOrder: null,
  column: 'waiting',
  derivedColumn: 'waiting',
  humanReview: null,
  botReview: null,
  ciState: null,
  doneAt: null,
  ...o,
})

// the row syncMyPrs wrote for a given PR id
const written = (id: string): MyPr | undefined =>
  vi
    .mocked(upsertMyPr)
    .mock.calls.map(([pr]) => pr)
    .filter((pr) => pr.id === id)
    .at(-1)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(allMyPrs).mockResolvedValue([])
  vi.mocked(listMyPrs).mockResolvedValue([])
  vi.mocked(migrateLegacyPrStore).mockResolvedValue({ columns: {}, orders: {} })
})

describe('syncMyPrs — a repo that fails keeps its cards', () => {
  it('does not touch the rows of a repo whose gh call threw', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr(), storedPr({ id: `${OTHER}#2`, repo: OTHER, number: 2 })])
    vi.mocked(listMyPrs).mockImplementation(async (repo) => {
      if (repo === REPO) throw new Error('gh: network is unreachable')
      return [ghPr({ number: 2 })]
    })

    await syncMyPrs(config())

    // nothing written or dropped for the repo that failed
    expect(vi.mocked(upsertMyPr).mock.calls.every(([pr]) => pr.repo === OTHER)).toBe(true)
    expect(vi.mocked(dropMyPrsMissingFrom).mock.calls.map(([repo]) => repo)).toEqual([OTHER])
  })

  it('still reconciles the repos that answered', async () => {
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)).toBeDefined()
    expect(vi.mocked(dropMyPrsMissingFrom)).toHaveBeenCalledWith(REPO, [`${REPO}#1`])
  })
})

describe('syncMyPrs — placement is resolved against the stored row', () => {
  it('keeps a card In Review when a re-requested review suppresses its review', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ column: 'in_review', derivedColumn: 'in_review' })])
    // the reviewer has a pending re-review request, so toMyPr suppresses their review -> derived waiting
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({
        latestReviews: [{ author: { login: 'alice' }, state: 'COMMENTED' }],
        reviewRequests: [{ login: 'alice' }],
      }),
    ])

    await syncMyPrs(config([REPO]))

    const row = written(`${REPO}#1`)
    expect(row?.derivedColumn).toBe('waiting') // GitHub's opinion is recorded...
    expect(row?.column).toBe('in_review') // ...but the card does not fall back
  })

  it('leaves a card dragged down to Waiting alone while GitHub says the same thing', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ column: 'waiting', derivedColumn: 'ready' })])
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }] }),
    ])

    await syncMyPrs(config([REPO]))

    expect(written(`${REPO}#1`)?.column).toBe('waiting')
  })

  it('promotes to Ready when a human approves', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ column: 'in_review', derivedColumn: 'in_review' })])
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }] }),
    ])

    await syncMyPrs(config([REPO]))

    expect(written(`${REPO}#1`)?.column).toBe('ready')
  })

  it('a bot review moves nothing but is still recorded for the badge', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr()])
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ latestReviews: [{ author: { login: 'cursor[bot]', is_bot: true }, state: 'CHANGES_REQUESTED' }] }),
    ])

    await syncMyPrs(config([REPO]))

    const row = written(`${REPO}#1`)
    expect(row?.column).toBe('waiting')
    expect(row?.botReview).toBe('changes_requested')
  })

  it('carries the stored drag position across a sync', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ sortOrder: 30 })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.sortOrder).toBe(30)
  })
})

describe('syncMyPrs — Done is scoped to today', () => {
  it('prunes merged and closed rows older than local midnight', async () => {
    await syncMyPrs(config([REPO]))
    const since = vi.mocked(pruneDoneMyPrs).mock.calls[0][0]
    const midnight = new Date(since)
    expect(midnight.getHours()).toBe(0)
    expect(midnight.toDateString()).toBe(new Date().toDateString())
  })

  it('boards a PR merged today, with its merge timestamp', async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString() // a minute ago, whenever "now" is
    vi.mocked(listMyPrs).mockResolvedValue([ghPr({ state: 'MERGED', mergedAt })])
    await syncMyPrs(config([REPO]))
    const row = written(`${REPO}#1`)
    expect(row?.column).toBe('done')
    expect(row?.doneAt).toBe(mergedAt)
  })

  // the listing hands back months of merges on every pass; boarding them and leaving it to the prune
  // would re-add them as fast as they're deleted, and Done would never empty
  it('does not board a PR merged before today', async () => {
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ state: 'MERGED', mergedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    ])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)).toBeUndefined()
  })

  it('drops a stored row once its merge falls out of today', async () => {
    // stale rows aren't in `seen`, so the per-repo reconcile removes them
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ state: 'MERGED', mergedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    ])
    await syncMyPrs(config([REPO]))
    expect(vi.mocked(dropMyPrsMissingFrom)).toHaveBeenCalledWith(REPO, [])
  })
})

describe('syncMyPrs — the retired pr-overrides.json is carried over once', () => {
  it('starts an unseen card at its old hand-off column', async () => {
    vi.mocked(migrateLegacyPrStore).mockResolvedValue({ columns: { [`${REPO}#1`]: 'ready' }, orders: {} })
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()]) // no reviews: GitHub would say waiting
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.column).toBe('ready')
  })

  it('does not let it overrule a card already stored', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ column: 'in_review', derivedColumn: 'waiting' })])
    vi.mocked(migrateLegacyPrStore).mockResolvedValue({ columns: { [`${REPO}#1`]: 'ready' }, orders: {} })
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.column).toBe('in_review')
  })

  it('carries the old drag position', async () => {
    vi.mocked(migrateLegacyPrStore).mockResolvedValue({ columns: {}, orders: { [`${REPO}#1`]: 20 } })
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.sortOrder).toBe(20)
  })
})
