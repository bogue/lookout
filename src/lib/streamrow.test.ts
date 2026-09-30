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
        sort_order: 10,
        priority: null,
        priority_reason: null,
        priority_source: null,
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
      sortOrder: 10,
      priority: null,
      priorityReason: null,
      prioritySource: null,
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
    sort_order: null,
    priority: 'meh',
    priority_reason: null,
    priority_source: 'oracle',
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
