import { describe, expect, it } from 'vitest'
import {
  emptyFilter,
  filterActive,
  matchesFilter,
  matchesReviews,
  openAuthorOptions,
  openRepoOptions,
  repoTitle,
} from './filters'

describe('matchesFilter', () => {
  it('matches everything when no filter is set', () => {
    expect(matchesFilter(emptyFilter, 'owner/repo', 'pass')).toBe(true)
    expect(matchesFilter(emptyFilter, 'owner/repo', null)).toBe(true)
  })

  it('filters by repo', () => {
    const f = { ...emptyFilter, repos: ['a/b'] }
    expect(matchesFilter(f, 'a/b', 'pass')).toBe(true)
    expect(matchesFilter(f, 'c/d', 'pass')).toBe(false)
  })

  it('filters by CI bucket, mapping null to "none"', () => {
    expect(matchesFilter({ ...emptyFilter, ci: ['fail'] }, 'a/b', 'fail')).toBe(true)
    expect(matchesFilter({ ...emptyFilter, ci: ['fail'] }, 'a/b', 'pass')).toBe(false)
    expect(matchesFilter({ ...emptyFilter, ci: ['none'] }, 'a/b', null)).toBe(true)
    expect(matchesFilter({ ...emptyFilter, ci: ['none'] }, 'a/b', 'pass')).toBe(false)
  })

  it('filters by author', () => {
    const f = { ...emptyFilter, authors: ['alice'] }
    expect(matchesFilter(f, 'a/b', 'pass', 'alice')).toBe(true)
    expect(matchesFilter(f, 'a/b', 'pass', 'bob')).toBe(false)
    expect(matchesFilter(f, 'a/b', 'pass')).toBe(false) // no author to match against
  })

  it('ANDs repo, CI and author', () => {
    const f = { repos: ['a/b'], ci: ['pass'], authors: ['alice'] }
    expect(matchesFilter(f, 'a/b', 'pass', 'alice')).toBe(true)
    expect(matchesFilter(f, 'a/b', 'fail', 'alice')).toBe(false)
    expect(matchesFilter(f, 'c/d', 'pass', 'alice')).toBe(false)
    expect(matchesFilter(f, 'a/b', 'pass', 'bob')).toBe(false)
  })
})

describe('filterActive', () => {
  it('is false only for the empty filter', () => {
    expect(filterActive(emptyFilter)).toBe(false)
    expect(filterActive({ ...emptyFilter, repos: ['a/b'] })).toBe(true)
    expect(filterActive({ ...emptyFilter, ci: ['pass'] })).toBe(true)
    expect(filterActive({ ...emptyFilter, authors: ['alice'] })).toBe(true)
  })
})

describe('repoTitle', () => {
  it('drops the owner prefix', () => {
    expect(repoTitle('TinxHQ/wazo-mobile')).toBe('wazo-mobile')
    expect(repoTitle('bare')).toBe('bare')
  })
})

describe('openRepoOptions', () => {
  it('keeps only repos with an open PR', () => {
    expect(
      openRepoOptions([
        { repo: 'o/live', open: true },
        { repo: 'o/merged', open: false },
      ]),
    ).toEqual([{ repo: 'o/live', count: 1 }])
  })

  it('counts only the open PRs of a repo', () => {
    expect(
      openRepoOptions([
        { repo: 'o/r', open: false },
        { repo: 'o/r', open: true },
        { repo: 'o/r', open: true },
      ]),
    ).toEqual([{ repo: 'o/r', count: 2 }])
  })

  it('sorts by title, ignoring the owner prefix', () => {
    expect(
      openRepoOptions([
        { repo: 'TinxHQ/wazo-mobile', open: true },
        { repo: 'wazo-platform/wazo-js-sdk', open: true },
        { repo: 'TinxHQ/portal-ui', open: true },
      ]).map((o) => o.repo),
    ).toEqual(['TinxHQ/portal-ui', 'wazo-platform/wazo-js-sdk', 'TinxHQ/wazo-mobile'])
  })
})

describe('openAuthorOptions', () => {
  it('lists authors of open PRs only, sorted and deduped', () => {
    expect(
      openAuthorOptions([
        { author: 'bob', open: true },
        { author: 'alice', open: true },
        { author: 'bob', open: true },
        { author: 'zoe', open: false },
      ]),
    ).toEqual(['alice', 'bob'])
  })
})

describe('matchesReviews', () => {
  it('matches everything when nothing is picked', () => {
    expect(matchesReviews([], null)).toBe(true)
    expect(matchesReviews([], 'approved')).toBe(true)
  })

  it('buckets a PR nobody reviewed as none', () => {
    expect(matchesReviews(['none'], null)).toBe(true)
    expect(matchesReviews(['none'], 'commented')).toBe(false)
  })

  it('matches any picked verdict', () => {
    expect(matchesReviews(['approved', 'changes_requested'], 'approved')).toBe(true)
    expect(matchesReviews(['approved', 'changes_requested'], 'commented')).toBe(false)
  })
})
