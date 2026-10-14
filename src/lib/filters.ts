import type { CiState, ReviewFlavor } from '../types'

// Board filter: selected repos ("projects"), PR authors and CI buckets.
// An empty list means "no filter on this field".
export type BoardFilter = { repos: string[]; ci: string[]; authors: string[] }

export const emptyFilter: BoardFilter = { repos: [], ci: [], authors: [] }

export const filterActive = (f: BoardFilter): boolean => f.repos.length > 0 || f.ci.length > 0 || f.authors.length > 0

// A card matches when its repo, author and CI bucket each pass their filter.
// CI null is bucketed as 'none' so "no CI" is selectable.
export const matchesFilter = (f: BoardFilter, repo: string, ci: CiState, author?: string): boolean =>
  (f.repos.length === 0 || f.repos.includes(repo)) &&
  (f.ci.length === 0 || f.ci.includes(ci ?? 'none')) &&
  (f.authors.length === 0 || (author !== undefined && f.authors.includes(author)))

// Discovery's Reviews filter: the other humans' latest verdict, 'none' when nobody reviewed yet.
// Nothing picked = every PR.
export const matchesReviews = (picked: string[], review: ReviewFlavor): boolean =>
  picked.length === 0 || picked.includes(review ?? 'none')

// the `repo` cards show: owner/name stripped down to name
export const repoTitle = (repo: string): string => repo.split('/')[1] ?? repo

const uniqSorted = (vals: string[], key: (v: string) => string = (v) => v): string[] =>
  [...new Set(vals)].sort((a, b) => key(a).localeCompare(key(b)))

// Pick-lists only offer what's live: a repo/author whose PRs are all merged is noise.
// Repos are ordered by the title the cards show, not by the owner prefix, and carry
// their open-PR count.
export type RepoOption = { repo: string; count: number }

export const openRepoOptions = (rows: { repo: string; open: boolean }[]): RepoOption[] => {
  const open = rows.filter((r) => r.open)
  return uniqSorted(
    open.map((r) => r.repo),
    repoTitle,
  ).map((repo) => ({ repo, count: open.filter((r) => r.repo === repo).length }))
}

export const openAuthorOptions = (rows: { author: string; open: boolean }[]): string[] =>
  uniqSorted(rows.filter((r) => r.open).map((r) => r.author))
