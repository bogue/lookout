import { describe, expect, it } from 'vitest'
import type { StreamItem } from '../types'
import { pickNext, STREAM_DENY, STREAM_TOOLS, streamBranch, streamPrompt, worktreeDir } from './streamrun'

const item = (over: Partial<StreamItem> = {}): StreamItem => ({
  id: '3f2a9c10-aaaa-bbbb-cccc-000000000000',
  repo: 'owner/app',
  groupId: null,
  title: 'implement card 1',
  body: null,
  refKind: null,
  ref: null,
  status: 'queued',
  gate: null,
  sortOrder: null,
  priority: null,
  priorityReason: null,
  prioritySource: null,
  branch: null,
  checkout: null,
  sessionIds: [],
  waitFor: null,
  steps: [],
  stepIndex: 0,
  templateId: null,
  guidelines: null,
  createdBy: 'me',
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  ...over,
})

describe('streamPrompt', () => {
  it('states the task, the project and the rules of a Stream run', () => {
    const p = streamPrompt(item())
    expect(p).toContain('implement card 1')
    expect(p).toContain('owner/app')
    expect(p).toMatch(/do not push/i)
  })

  it('tells the agent how to stop and ask me through the CLI', () => {
    expect(streamPrompt(item())).toContain('lookout stream gate --kind question')
  })

  it('adds my notes and the reference when there are some', () => {
    const p = streamPrompt(item({ body: 'keep the old API', refKind: 'url', ref: 'https://notion.so/Card-1' }))
    expect(p).toContain('keep the old API')
    expect(p).toContain('https://notion.so/Card-1')
  })

  it('names the PR for a PR reference', () => {
    expect(streamPrompt(item({ refKind: 'pr', ref: 'owner/app#2' }))).toContain('pull request #2')
  })

  it('runs a skill line as is, rules after it', () => {
    const p = streamPrompt(item({ title: '/do-followup 2' }))
    expect(p.startsWith('/do-followup 2')).toBe(true)
    expect(p).toMatch(/do not push/i)
  })
})

describe('stream tools', () => {
  const allowed = STREAM_TOOLS.split(',')
  const denied = STREAM_DENY.split(',')

  it('lets an agent commit, never push, merge or publish on its own', () => {
    expect(allowed).toContain('Bash(git commit:*)')
    expect(allowed).not.toContain('Bash(git:*)')
    expect(allowed).not.toContain('Bash(gh:*)')
    expect(denied).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr create:*)', 'Bash(gh api:*)']),
    )
  })
})

describe('streamBranch', () => {
  it('names a new work branch after the item, no slash, no conventional prefix', () => {
    expect(streamBranch('3f2a9c10-aaaa-bbbb-cccc-000000000000')).toBe('lookout-stream-3f2a9c10')
  })
})

describe('worktreeDir', () => {
  it('puts the worktree under the clone, where Claude Code puts its own', () => {
    expect(worktreeDir('/Users/me/Projects/app', 'lookout-stream-3f2a9c10')).toBe(
      '/Users/me/Projects/app/.claude/worktrees/lookout-stream-3f2a9c10',
    )
  })
})

describe('pickNext', () => {
  const caps = { global: 2, perProject: 2 }
  const ids = (xs: StreamItem[]) => xs.map((x) => x.id)

  it('picks queued cards top first, up to the global cap', () => {
    const xs = [
      item({ id: 'b', createdAt: '2026-09-30T10:00:02.000Z' }),
      item({ id: 'a', createdAt: '2026-09-30T10:00:01.000Z' }),
      item({ id: 'c', createdAt: '2026-09-30T10:00:03.000Z' }),
    ]
    expect(ids(pickNext(xs, caps))).toEqual(['a', 'b'])
  })

  it('counts what already runs against both caps', () => {
    const xs = [item({ id: 'r', status: 'running' }), item({ id: 'a' }), item({ id: 'b', repo: 'acme/api' })]
    expect(ids(pickNext(xs, { global: 2, perProject: 1 }))).toEqual(['b'])
  })

  it('never picks a paused card or one with no project yet', () => {
    const xs = [item({ id: 'p', status: 'paused' }), item({ id: 'u', repo: '' }), item({ id: 'ok' })]
    expect(ids(pickNext(xs, caps))).toEqual(['ok'])
  })

  it('lets a card waiting on me take no slot', () => {
    const xs = [item({ id: 'w', status: 'needs_review' }), item({ id: 'x', status: 'watching' }), item({ id: 'a' })]
    expect(ids(pickNext(xs, { global: 1, perProject: 1 }))).toEqual(['a'])
  })

  it('follows my drag order', () => {
    const xs = [item({ id: 'a' }), item({ id: 'b', sortOrder: 10 })]
    expect(ids(pickNext(xs, { global: 1, perProject: 1 }))).toEqual(['b'])
  })
})
