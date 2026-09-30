import { describe, expect, it } from 'vitest'
import { rowToStreamEvent, rowToStreamItem } from './streamrow'

describe('rowToStreamItem', () => {
  it('maps the row to an item', () => {
    expect(
      rowToStreamItem({
        id: 'i1',
        repo: 'owner/app',
        group_id: null,
        title: 'follow up on PR #2',
        body: null,
        ref_kind: 'pr',
        ref: 'owner/app#2',
        status: 'queued',
        gate: null,
        sort_order: 10,
        priority: null,
        priority_reason: null,
        priority_source: null,
        branch: 'lookout-stream-i1',
        checkout: '/p/app/.claude/worktrees/lookout-stream-i1',
        session_ids: '["s1","s2"]',
        created_by: 'me',
        created_at: '2026-09-30T00:00:00Z',
        updated_at: '2026-09-30T01:00:00Z',
      }),
    ).toEqual({
      id: 'i1',
      repo: 'owner/app',
      groupId: null,
      title: 'follow up on PR #2',
      body: null,
      refKind: 'pr',
      ref: 'owner/app#2',
      status: 'queued',
      gate: null,
      sortOrder: 10,
      priority: null,
      priorityReason: null,
      prioritySource: null,
      branch: 'lookout-stream-i1',
      checkout: '/p/app/.claude/worktrees/lookout-stream-i1',
      sessionIds: ['s1', 's2'],
      createdBy: 'me',
      createdAt: '2026-09-30T00:00:00Z',
      updatedAt: '2026-09-30T01:00:00Z',
    })
  })
})

describe('rowToStreamItem on values this build does not know', () => {
  const row = {
    id: 'i1',
    repo: 'owner/app',
    group_id: null,
    title: 't',
    body: null,
    ref_kind: 'jira',
    ref: 'X-1',
    status: 'teleporting',
    gate: null,
    sort_order: null,
    priority: 'meh',
    priority_reason: null,
    priority_source: 'oracle',
    branch: null,
    checkout: null,
    session_ids: 'not json',
    created_by: 'me',
    created_at: '2026-09-30T00:00:00Z',
    updated_at: '2026-09-30T00:00:00Z',
  }

  // a row written by a newer build (or by hand) must not crash the board
  it('falls back to a status, priority and ref kind the board can render', () => {
    expect(rowToStreamItem(row)).toMatchObject({
      status: 'idea',
      priority: null,
      prioritySource: null,
      refKind: null,
      sessionIds: [],
    })
  })
})

describe('rowToStreamEvent', () => {
  it('maps the row to an event', () => {
    expect(
      rowToStreamEvent({ id: 3, item_id: 'i1', ts: '2026-09-30T00:00:00Z', actor: 'me', kind: 'created', text: null }),
    ).toEqual({ id: 3, itemId: 'i1', ts: '2026-09-30T00:00:00Z', actor: 'me', kind: 'created', text: null })
  })
})
