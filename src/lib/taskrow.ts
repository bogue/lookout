import type { ReviewTask, Stage } from '../types'
import { ciChecksOf } from './myprrow'

// The `tasks` table row, exactly as the schema defines it (src-tauri/migrations/001_tasks.sql and up).
// Shared so the two drivers that read this table agree on its shape: the app (tauri-plugin-sql) and
// the CLI (node:sqlite). Change the schema and both sides fail to compile together.
export type TaskRow = {
  id: string
  repo: string
  repo_path: string | null
  branch: string
  pr_number: number
  pr_title: string
  pr_url: string
  pr_state: string
  pr_author: string
  pr_created_at: string | null
  is_draft: number
  stage: string
  review_requested: number
  session_ids: string
  review_files: string
  followup_summary: string | null
  activity_count: number | null
  ci_state: string | null
  ci_failed?: number | null // migration 017
  ci_total?: number | null
  conflicts?: number // migration 018
  approved?: number // migration 019
  new_activity: number
  snoozed: number
  seen: number
  sort_order: number | null
  done_at: string | null
  updated_at: string
}

export const toTask = (r: TaskRow): ReviewTask => ({
  id: r.id,
  repo: r.repo,
  repoPath: r.repo_path,
  branch: r.branch,
  prNumber: r.pr_number,
  prTitle: r.pr_title,
  prUrl: r.pr_url,
  prState: r.pr_state as ReviewTask['prState'],
  prAuthor: r.pr_author,
  prCreatedAt: r.pr_created_at,
  isDraft: r.is_draft === 1,
  stage: r.stage as Stage,
  reviewRequested: r.review_requested === 1,
  sessionIds: JSON.parse(r.session_ids),
  reviewFiles: JSON.parse(r.review_files),
  followupSummary: r.followup_summary ? JSON.parse(r.followup_summary) : null,
  activityCount: r.activity_count,
  ciState: r.ci_state as ReviewTask['ciState'],
  ciChecks: ciChecksOf(r.ci_failed, r.ci_total),
  conflicts: r.conflicts === 1,
  approved: r.approved === 1,
  hasNewActivity: r.new_activity === 1,
  snoozed: r.snoozed === 1,
  seen: r.seen === 1,
  sortOrder: r.sort_order,
  doneAt: r.done_at,
  updatedAt: r.updated_at,
})

// A stage move touches three columns; both drivers must write the same thing, so the values come
// from here. `done_at` stamps when a card lands in Done and clears when it leaves.
export const stageUpdate = (stage: Stage, now = new Date().toISOString()) => ({
  stage,
  done_at: stage === 'done' ? now : null,
  updated_at: now,
})
