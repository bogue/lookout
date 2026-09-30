import type { StreamEvent, StreamItem, StreamStatus } from '../types'
import { STATUS_LABEL } from './stream'

// The `stream_items` columns the board reads (src-tauri/migrations/022_stream.sql). The step/run
// columns are left out until the dispatch phases read them.
export type StreamItemRow = {
  id: string
  repo: string
  group_id: string | null
  title: string
  body: string | null
  ref_kind: string | null
  ref: string | null
  status: string
  sort_order: number | null
  priority: string | null
  priority_reason: string | null
  priority_source: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export type StreamEventRow = {
  id: number
  item_id: string
  ts: string
  actor: string
  kind: string
  text: string | null
}

// A value this build doesn't know (a row from a newer build, or edited by hand) falls back to one the
// board can render, instead of crashing a lookup table keyed by the known ones.
const oneOf = <T extends string>(v: string | null, known: readonly T[], fallback: T | null): T | null =>
  known.includes(v as T) ? (v as T) : fallback

const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const

export const rowToStreamItem = (r: StreamItemRow): StreamItem => ({
  id: r.id,
  repo: r.repo,
  groupId: r.group_id,
  title: r.title,
  body: r.body,
  refKind: oneOf(r.ref_kind, ['pr', 'url'], null),
  ref: r.ref,
  status: oneOf(r.status, Object.keys(STATUS_LABEL) as StreamStatus[], 'idea') ?? 'idea',
  sortOrder: r.sort_order,
  priority: oneOf(r.priority, PRIORITIES, null),
  priorityReason: r.priority_reason,
  prioritySource: oneOf(r.priority_source, ['haiku', 'me'], null),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export const rowToStreamEvent = (r: StreamEventRow): StreamEvent => ({
  id: r.id,
  itemId: r.item_id,
  ts: r.ts,
  actor: r.actor,
  kind: r.kind,
  text: r.text,
})
