import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, MyPr } from '../types'
import type { GhMyPr } from './gh'

vi.mock('./config', () => ({ getConfig: vi.fn(), setGithubUser: vi.fn() }))
vi.mock('./db', () => ({
  allMyPrs: vi.fn(async () => []),
  dropMyPrsMissingFrom: vi.fn(),
  ghLogins: vi.fn(async () => new Map()),
  pruneDoneMyPrs: vi.fn(),
  pruneMyPrRepos: vi.fn(),
  saveGhLogins: vi.fn(async () => {}),
  setMyPrSnoozed: vi.fn(),
  syncAlerts: vi.fn(async () => []),
  upsertMyPr: vi.fn(),
}))
vi.mock('./gh', () => ({
  fetchAuthorKinds: vi.fn(async () => new Map()),
  fetchLogin: vi.fn(),
  fetchMyPr: vi.fn(),
  fetchPrExchange: vi.fn(async () => ({ count: 0, ciState: null, reviews: [], comments: [], commits: [] })),
  listMyPrs: vi.fn(),
}))
vi.mock('./notify', () => ({ notify: vi.fn() }))
vi.mock('./proverrides', () => ({ migrateLegacyPrStore: vi.fn(async () => ({ columns: {}, orders: {} })) }))

import {
  allMyPrs,
  dropMyPrsMissingFrom,
  ghLogins,
  pruneDoneMyPrs,
  saveGhLogins,
  setMyPrSnoozed,
  upsertMyPr,
} from './db'
import { fetchAuthorKinds, fetchMyPr, fetchPrExchange, listMyPrs, type PrExchange } from './gh'
import { snoozeMyPr, syncMyPrs } from './myprs'
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
  captureReviews: false,
  openInBrowser: false,
  notifications: true,
  mergeMethod: 'merge',
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
  ciChecks: null,
  conflicts: false,
  approved: false,
  activityCount: null,
  doneAt: null,
  snoozed: false,
  ...o,
})

const exchange = (comments: { author: { login?: string; is_bot?: boolean } }[]): PrExchange => ({
  count: comments.length,
  ciState: null,
  ciChecks: null,
  conflicts: false,
  reviews: [],
  comments: comments.map((c) => ({ ...c, createdAt: '2026-09-02T00:00:00Z' })),
  commits: [],
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
  vi.mocked(ghLogins).mockResolvedValue(new Map())
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

describe('syncMyPrs — a snoozed card sleeps until GitHub has news', () => {
  it('stays snoozed while nothing about the PR changed', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.snoozed).toBe(true)
  })

  it('wakes on a new review', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true })])
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ latestReviews: [{ author: { login: 'alice' }, state: 'COMMENTED' }] }),
    ])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.snoozed).toBe(false)
  })

  it('wakes when CI turns red', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, ciState: 'pending' })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr({ statusCheckRollup: [{ conclusion: 'FAILURE' }] })])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.snoozed).toBe(false)
  })

  it('keeps sleeping through a push that cycles CI pending -> pass', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, ciState: 'pass' })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] })])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.snoozed).toBe(true)

    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, ciState: 'pending' })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr({ statusCheckRollup: [{ conclusion: 'SUCCESS' }] })])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.snoozed).toBe(true)
  })

  it('wakes on a new comment even when the review verdict stays the same', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, activityCount: 1 })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    vi.mocked(fetchPrExchange).mockResolvedValueOnce(
      exchange([{ author: { login: 'alice' } }, { author: { login: 'bob' } }]),
    )
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)).toMatchObject({ snoozed: false, activityCount: 2 })
  })

  it("doesn't wake on my own comments or a bot's", async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, activityCount: 0 })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    vi.mocked(fetchPrExchange).mockResolvedValueOnce(
      exchange([
        { author: { login: 'me' } },
        { author: { login: 'codecov[bot]' } },
        { author: { login: 'x', is_bot: true } },
      ]),
    )
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)).toMatchObject({ snoozed: true, activityCount: 0 })
  })

  it('takes the first count as a baseline without waking', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, activityCount: null })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    vi.mocked(fetchPrExchange).mockResolvedValueOnce(exchange([{ author: { login: 'alice' } }]))
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)).toMatchObject({ snoozed: true, activityCount: 1 })
  })

  it('keeps the stored count when the fetch fails', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, activityCount: 3 })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    vi.mocked(fetchPrExchange).mockRejectedValueOnce(new Error('network'))
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)).toMatchObject({ snoozed: true, activityCount: 3 })
  })

  it('wakes when the PR runs into merge conflicts', async () => {
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr({ mergeable: 'CONFLICTING' })])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.snoozed).toBe(false)
  })

  it('boards a PR it never saw awake', async () => {
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.snoozed).toBe(false)
  })
})

// gh's --json drops the Bot type from review/comment authors ("cursor", not "cursor[bot]")
describe('syncMyPrs — bots gh reports as plain logins', () => {
  it("treats a GraphQL-confirmed bot's review as a bot's, not a person's", async () => {
    vi.mocked(fetchAuthorKinds).mockResolvedValueOnce(new Map([['cursor', true]]))
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ latestReviews: [{ author: { login: 'cursor' }, state: 'COMMENTED' }] }),
    ])
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)).toMatchObject({ humanReview: null, botReview: 'commented', column: 'waiting' })
  })

  it("doesn't wake a snoozed card when such a bot re-reviews or comments", async () => {
    vi.mocked(fetchAuthorKinds).mockResolvedValueOnce(new Map([['sonar', true]]))
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, activityCount: 0 })])
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    vi.mocked(fetchPrExchange).mockResolvedValueOnce(exchange([{ author: { login: 'sonar' } }]))
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)).toMatchObject({ snoozed: true, activityCount: 0 })
  })

  it('reads a stored bot as a bot without asking GitHub again', async () => {
    vi.mocked(ghLogins).mockResolvedValue(new Map([['linter', true]]))
    vi.mocked(allMyPrs).mockResolvedValue([storedPr({ snoozed: true, botReview: 'commented' })])
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ latestReviews: [{ author: { login: 'linter' }, state: 'COMMENTED' }] }),
    ])
    await syncMyPrs(config([REPO]))
    expect(fetchAuthorKinds).not.toHaveBeenCalled()
    expect(written(`${REPO}#1`)).toMatchObject({ snoozed: true, humanReview: null, botReview: 'commented' })
  })

  it('asks only about new logins, on the PRs where they appear', async () => {
    vi.mocked(ghLogins).mockResolvedValue(new Map([['alice', false]]))
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ number: 1, latestReviews: [{ author: { login: 'alice' }, state: 'COMMENTED' }] }),
      ghPr({ number: 2 }),
      ghPr({ number: 3, state: 'MERGED', mergedAt: new Date().toISOString() }),
    ])
    vi.mocked(fetchPrExchange)
      .mockResolvedValueOnce(exchange([{ author: { login: 'alice' } }, { author: { login: 'me' } }]))
      .mockResolvedValueOnce(exchange([{ author: { login: 'bob' } }, { author: { login: 'ci[bot]' } }]))
    await syncMyPrs(config([REPO]))
    expect(fetchAuthorKinds).toHaveBeenCalledWith(REPO, [2])
  })

  it('stores what it learned, people and logins the answer left out included', async () => {
    vi.mocked(fetchAuthorKinds).mockResolvedValueOnce(
      new Map([
        ['bob', false],
        ['cursor', true],
      ]),
    )
    vi.mocked(listMyPrs).mockResolvedValue([ghPr()])
    vi.mocked(fetchPrExchange).mockResolvedValueOnce(
      exchange([{ author: { login: 'bob' } }, { author: { login: 'cursor' } }, { author: { login: 'old' } }]),
    )
    await syncMyPrs(config([REPO]))
    expect(saveGhLogins).toHaveBeenCalledWith(
      new Map([
        ['bob', false],
        ['cursor', true],
        ['old', false],
      ]),
    )
  })

  it('stores nothing when the lookup fails, so the next sync asks again', async () => {
    vi.mocked(fetchAuthorKinds).mockRejectedValueOnce(new Error('graphql'))
    vi.mocked(listMyPrs).mockResolvedValue([
      ghPr({ latestReviews: [{ author: { login: 'linter' }, state: 'COMMENTED' }] }),
    ])
    await syncMyPrs(config([REPO]))
    expect(saveGhLogins).not.toHaveBeenCalled()
    await syncMyPrs(config([REPO]))
    expect(fetchAuthorKinds).toHaveBeenCalledTimes(2)
  })
})

describe('snoozeMyPr — the snooze is the baseline', () => {
  it("doesn't wake on the next sync over a verdict only the panel's timeline saw", async () => {
    // panel stored the timeline's verdict; the list call sees a pending re-review request instead
    const panel = storedPr({ humanReview: 'changes_requested', derivedColumn: 'in_review', column: 'in_review' })
    const listed = ghPr({
      latestReviews: [{ author: { login: 'alice' }, state: 'CHANGES_REQUESTED' }],
      reviewRequests: [{ login: 'alice' }],
    })
    vi.mocked(fetchMyPr).mockResolvedValueOnce(listed)
    vi.mocked(fetchPrExchange).mockResolvedValueOnce(exchange([{ author: { login: 'alice' } }]))
    await snoozeMyPr(panel, 'me')
    const baseline = written(`${REPO}#1`)
    expect(baseline).toMatchObject({ snoozed: true, humanReview: null, activityCount: 1 })

    vi.mocked(allMyPrs).mockResolvedValue([baseline as MyPr])
    vi.mocked(listMyPrs).mockResolvedValue([listed])
    vi.mocked(fetchPrExchange).mockResolvedValueOnce(exchange([{ author: { login: 'alice' } }]))
    await syncMyPrs(config([REPO]))
    expect(written(`${REPO}#1`)?.snoozed).toBe(true)
  })

  it('counts the comments there at snooze time, not those of the last sync', async () => {
    vi.mocked(fetchMyPr).mockResolvedValueOnce(ghPr())
    vi.mocked(fetchPrExchange).mockResolvedValueOnce(
      exchange([{ author: { login: 'alice' } }, { author: { login: 'bob' } }]),
    )
    await snoozeMyPr(storedPr({ activityCount: 1 }), 'me')
    expect(written(`${REPO}#1`)).toMatchObject({ snoozed: true, activityCount: 2 })
  })

  it('keeps my placement and drag position', async () => {
    vi.mocked(fetchMyPr).mockResolvedValueOnce(ghPr())
    await snoozeMyPr(storedPr({ column: 'ready', sortOrder: 30 }), 'me')
    expect(written(`${REPO}#1`)).toMatchObject({ column: 'ready', sortOrder: 30 })
  })

  it('still snoozes when GitHub is unreachable', async () => {
    vi.mocked(fetchMyPr).mockRejectedValueOnce(new Error('network'))
    await snoozeMyPr(storedPr(), 'me')
    expect(upsertMyPr).not.toHaveBeenCalled()
    expect(setMyPrSnoozed).toHaveBeenCalledWith(`${REPO}#1`, true)
  })
})
