import type { StreamItem } from '../types'
import { prRefOf, sortColumn } from './stream'

// Pure rules of running a Stream item: what the agent is told, where it works, which card goes next.

// The rules every Stream run follows. The result gate is the point: nothing leaves the machine until
// I approved it, so the agent stops at a summary instead of pushing.
const RULES = `You are working on an item from my Lookout Stream board, in a git worktree dedicated to it.
- Do the task. Commit your work on the current branch with conventional commit messages.
- Do not push, open or merge pull requests, post comments, or publish anything unless the task explicitly asks for it: I review first.
- If something is unclear or blocked, stop and ask in your final message rather than guessing.
- End with a short summary: what you did, what I should look at, and anything left open.`

// What the agent is told. A line that is a skill (`/do-followup 2`) runs as is, rules after it.
export const streamPrompt = (item: StreamItem): string => {
  const pr = item.refKind === 'pr' && item.ref ? prRefOf(item.ref) : null
  const context = [
    `Project: ${item.repo}`,
    pr ? `It is about pull request #${pr.number} (${pr.url}).` : null,
    item.refKind === 'url' && item.ref ? `Reference: ${item.ref}` : null,
    item.body ? `Notes:\n${item.body}` : null,
  ].filter(Boolean)
  const task = item.title.startsWith('/') ? item.title : `Task: ${item.title}`
  return [task, ...context, RULES].join('\n\n')
}

// a new work item's branch: kebab-case, no `/`, no conventional prefix
export const streamBranch = (id: string) => `lookout-stream-${id.slice(0, 8)}`

// where its worktree lives: under the clone, next to the ones Claude Code creates
export const worktreeDir = (repoPath: string, branch: string) => `${repoPath}/.claude/worktrees/${branch}`

// Which queued cards start now: top of Queued first, while a run slot is free overall and in that
// project. Only running cards take a slot — one waiting on me or on GitHub is an idle session.
export const pickNext = (items: StreamItem[], caps: { global: number; perProject: number }): StreamItem[] => {
  const running = items.filter((x) => x.status === 'running')
  let total = running.length
  const perRepo = new Map<string, number>()
  for (const x of running) perRepo.set(x.repo, (perRepo.get(x.repo) ?? 0) + 1)
  const picked: StreamItem[] = []
  for (const x of sortColumn(items, 'queued')) {
    if (total >= caps.global) break
    if (x.status !== 'queued' || !x.repo) continue
    if ((perRepo.get(x.repo) ?? 0) >= caps.perProject) continue
    picked.push(x)
    total++
    perRepo.set(x.repo, (perRepo.get(x.repo) ?? 0) + 1)
  }
  return picked
}
