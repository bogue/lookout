import { describe, expect, it } from 'vitest'
import type { ReviewTask } from '../types'
import type { Db } from './db'
import { AmbiguousError, NoMatchError, repoFromRemote, resolveCard } from './resolve'

const task = (id: string, branch: string, pr: number, repo = 'owner/repo'): ReviewTask =>
  ({ id, repo, branch, prNumber: pr, stage: 'watching' }) as ReviewTask

// A Db stand-in that records the filter it was asked for, so the tests assert on intent.
const fakeDb = (tasks: ReviewTask[]) => {
  const calls: unknown[] = []
  const db = {
    tasks: (filter = {}) => {
      calls.push(filter)
      const f = filter as { repo?: string; branch?: string; prNumber?: number }
      return tasks.filter(
        (t) =>
          (f.repo === undefined || t.repo === f.repo) &&
          (f.branch === undefined || t.branch === f.branch) &&
          (f.prNumber === undefined || t.prNumber === f.prNumber),
      )
    },
    task: (id: string) => tasks.find((t) => t.id === id) ?? null,
  } as unknown as Db
  return { db, calls }
}

const git = (remote: string | null, branch: string | null) => ({ remote: () => remote, branch: () => branch })

describe('repoFromRemote', () => {
  it('reads owner/repo out of every remote form', () => {
    expect(repoFromRemote('git@github.com:TinxHQ/wazo-mobile.git')).toBe('TinxHQ/wazo-mobile')
    expect(repoFromRemote('https://github.com/TinxHQ/wazo-mobile.git')).toBe('TinxHQ/wazo-mobile')
    expect(repoFromRemote('https://github.com/TinxHQ/wazo-mobile')).toBe('TinxHQ/wazo-mobile')
  })

  it('ignores a non-GitHub remote', () => expect(repoFromRemote('git@gitlab.com:a/b.git')).toBeNull())
})

describe('resolveCard', () => {
  it('takes --id verbatim', () => {
    const { db } = fakeDb([task('owner/repo#1', 'alpha', 1)])
    expect(resolveCard(db, { id: 'owner/repo#1' }, git(null, null)).id).toBe('owner/repo#1')
  })

  it('errors on an unknown --id', () => {
    const { db } = fakeDb([])
    expect(() => resolveCard(db, { id: 'owner/repo#9' }, git(null, null))).toThrow(NoMatchError)
  })

  it('infers repo and branch from the working copy', () => {
    const { db, calls } = fakeDb([task('owner/repo#1', 'alpha', 1)])
    const found = resolveCard(db, {}, git('git@github.com:owner/repo.git', 'alpha'))
    expect(found.id).toBe('owner/repo#1')
    expect(calls[0]).toEqual({ repo: 'owner/repo', branch: 'alpha', prNumber: undefined })
  })

  it('prefers an explicit --branch over the checked-out one', () => {
    const { db } = fakeDb([task('owner/repo#1', 'alpha', 1), task('owner/repo#2', 'beta', 2)])
    expect(resolveCard(db, { branch: 'beta' }, git('git@github.com:owner/repo.git', 'alpha')).id).toBe('owner/repo#2')
  })

  it('does not mix an explicit selector with an inferred repo', () => {
    // --pr from an unrelated working copy must not be scoped to that copy's repo
    const { db, calls } = fakeDb([task('other/repo#7', 'seven', 7, 'other/repo')])
    expect(resolveCard(db, { pr: 7 }, git('git@github.com:owner/repo.git', 'main')).id).toBe('other/repo#7')
    expect(calls[0]).toEqual({ repo: undefined, branch: undefined, prNumber: 7 })
  })

  it('still scopes by repo when --repo is given', () => {
    const { db } = fakeDb([task('a/b#1', 'shared', 1, 'a/b'), task('c/d#1', 'shared', 1, 'c/d')])
    expect(resolveCard(db, { repo: 'c/d', branch: 'shared' }, git(null, null)).id).toBe('c/d#1')
  })

  it('matches on --pr without needing a branch', () => {
    const { db, calls } = fakeDb([task('owner/repo#7', 'seven', 7)])
    expect(resolveCard(db, { pr: 7 }, git(null, null)).id).toBe('owner/repo#7')
    expect(calls[0]).toEqual({ repo: undefined, branch: undefined, prNumber: 7 })
  })

  it('reports no match with the selector it tried', () => {
    const { db } = fakeDb([])
    expect(() => resolveCard(db, { pr: 42 }, git(null, null))).toThrow(/PR #42/)
    expect(() => resolveCard(db, {}, git(null, 'alpha'))).toThrow(/branch alpha/)
  })

  it('refuses to guess when several cards match', () => {
    const { db } = fakeDb([task('a/b#1', 'shared', 1, 'a/b'), task('c/d#2', 'shared', 2, 'c/d')])
    expect(() => resolveCard(db, { branch: 'shared' }, git(null, null))).toThrow(AmbiguousError)
  })

  it('works outside a git repo when the selector is explicit', () => {
    const { db } = fakeDb([task('owner/repo#1', 'alpha', 1)])
    expect(resolveCard(db, { repo: 'owner/repo', branch: 'alpha' }, git(null, null)).id).toBe('owner/repo#1')
  })
})
