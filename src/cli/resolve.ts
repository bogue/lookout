import { execFileSync } from 'node:child_process'
import type { MyPr, ReviewTask } from '../types'
import type { Db } from './db'

export type Selector = { id?: string; pr?: number; branch?: string; repo?: string }

export class NoMatchError extends Error {}
export class AmbiguousError extends Error {
  constructor(readonly matches: { id: string; branch: string }[]) {
    super(`${matches.length} match — narrow it with --repo or --id`)
  }
}

type Git = { remote: () => string | null; branch: () => string | null }

const run = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

// `owner/repo` out of any GitHub remote form (ssh, https, with or without .git)
export const repoFromRemote = (url: string): string | null =>
  url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?\/?$/)?.[1] ?? null

export const gitFromCwd = (): Git => ({
  remote: () => run(['remote', 'get-url', 'origin']),
  branch: () => run(['rev-parse', '--abbrev-ref', 'HEAD']),
})

type Filter = { repo?: string; branch?: string; prNumber?: number }

// Which card a command acts on. One rule for both boards, so the result is never a mix of what you
// asked for and what we guessed: name any selector and only that is used; name none and both repo
// and branch come from the working copy — which is what lets a skill call `lookout review reviewed`
// or `lookout mine ready` bare, from inside the clone.
const resolveOne = <T extends { id: string; branch: string }>(
  byId: (id: string) => T | null,
  list: (filter: Filter) => T[],
  sel: Selector,
  git: Git,
  noun: string,
): T => {
  if (sel.id) {
    const found = byId(sel.id)
    if (!found) throw new NoMatchError(`no ${noun} ${sel.id}`)
    return found
  }

  const explicit = sel.pr !== undefined || sel.branch !== undefined || sel.repo !== undefined
  const remote = git.remote()
  const filter: Filter = explicit
    ? { repo: sel.repo, branch: sel.branch, prNumber: sel.pr }
    : {
        repo: (remote ? repoFromRemote(remote) : null) ?? undefined,
        branch: git.branch() ?? undefined,
        prNumber: undefined,
      }

  const matches = list(filter)
  if (matches.length === 0) {
    const how = filter.prNumber !== undefined ? `PR #${filter.prNumber}` : `branch ${filter.branch ?? '(unknown)'}`
    throw new NoMatchError(`no ${noun} for ${how}${filter.repo ? ` in ${filter.repo}` : ''}`)
  }
  if (matches.length > 1) throw new AmbiguousError(matches)
  return matches[0]
}

export const resolveCard = (db: Db, sel: Selector, git: Git = gitFromCwd()): ReviewTask =>
  resolveOne(db.task, db.tasks, sel, git, 'card')

export const resolveMyPr = (db: Db, sel: Selector, git: Git = gitFromCwd()): MyPr =>
  resolveOne(db.myPr, db.myPrs, sel, git, 'PR of yours')
