import Database from '@tauri-apps/plugin-sql'
import type { Alert, AlertKind, MyPr, PrColumn, ReviewTask, Stage } from '../types'
import { type AlertScope, inScope } from './alerts'
import { type MyPrRow, rowToMyPr } from './myprrow'
import { stageUpdate, type TaskRow, toTask } from './taskrow'

let db: Database | null = null

const getDb = async () => {
  if (!db) db = await Database.load('sqlite:lookout.db')
  return db
}

export const allTasks = async (): Promise<ReviewTask[]> => {
  const d = await getDb()
  const rows = await d.select<TaskRow[]>('SELECT * FROM tasks ORDER BY updated_at DESC')
  return rows.map(toTask)
}

// drop tasks whose repo is no longer watched (e.g. a project removed from Settings)
export const pruneRepos = async (repos: string[]) => {
  const d = await getDb()
  if (repos.length === 0) {
    await d.execute('DELETE FROM tasks')
    return
  }
  const placeholders = repos.map((_, i) => `$${i + 1}`).join(', ')
  await d.execute(`DELETE FROM tasks WHERE repo NOT IN (${placeholders})`, repos)
}

export const upsertPr = async (t: {
  id: string
  repo: string
  repoPath: string
  branch: string
  prNumber: number
  prTitle: string
  prUrl: string
  prAuthor: string
  prCreatedAt: string
  reviewRequested: boolean
  isDraft: boolean
}) => {
  const d = await getDb()
  await d.execute(
    `INSERT INTO tasks (id, repo, repo_path, branch, pr_number, pr_title, pr_url, pr_author, pr_created_at, review_requested, is_draft, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT(id) DO UPDATE SET
       pr_title = $6, pr_url = $7, pr_created_at = $9, review_requested = $10, is_draft = $11, repo_path = $3, updated_at = $12`,
    [
      t.id,
      t.repo,
      t.repoPath,
      t.branch,
      t.prNumber,
      t.prTitle,
      t.prUrl,
      t.prAuthor,
      t.prCreatedAt,
      t.reviewRequested ? 1 : 0,
      t.isDraft ? 1 : 0,
      new Date().toISOString(),
    ],
  )
}

export const setStage = async (id: string, stage: Stage) => {
  const d = await getDb()
  const u = stageUpdate(stage)
  await d.execute('UPDATE tasks SET stage = $1, done_at = $2, updated_at = $3 WHERE id = $4', [
    u.stage,
    u.done_at,
    u.updated_at,
    id,
  ])
}

export const setPrState = async (id: string, prState: string) => {
  const d = await getDb()
  await d.execute('UPDATE tasks SET pr_state = $1, updated_at = $2 WHERE id = $3', [
    prState,
    new Date().toISOString(),
    id,
  ])
}

export const setActivity = async (id: string, count: number, ciState: string | null, isNew: boolean) => {
  const d = await getDb()
  // new activity wakes a snoozed card
  await d.execute(
    `UPDATE tasks SET activity_count = $1, ci_state = $2, new_activity = MAX(new_activity, $3),
       snoozed = CASE WHEN $3 = 1 THEN 0 ELSE snoozed END
     WHERE id = $4`,
    [count, ciState, isNew ? 1 : 0, id],
  )
}

export const setOrders = async (orderedIds: string[]) => {
  const d = await getDb()
  for (const [i, id] of orderedIds.entries()) {
    await d.execute('UPDATE tasks SET sort_order = $1 WHERE id = $2', [(i + 1) * 10, id])
  }
}

export const setSnoozed = async (id: string, snoozed: boolean) => {
  const d = await getDb()
  await d.execute('UPDATE tasks SET snoozed = $1 WHERE id = $2', [snoozed ? 1 : 0, id])
}

export const setSeen = async (id: string, seen: boolean) => {
  const d = await getDb()
  await d.execute('UPDATE tasks SET seen = $1 WHERE id = $2', [seen ? 1 : 0, id])
}

export const clearNewActivity = async (id: string) => {
  const d = await getDb()
  await d.execute('UPDATE tasks SET new_activity = 0 WHERE id = $1', [id])
}

export const addSessionId = async (id: string, sessionId: string) => {
  const d = await getDb()
  const rows = await d.select<TaskRow[]>('SELECT * FROM tasks WHERE id = $1', [id])
  if (!rows.length) return
  const ids: string[] = JSON.parse(rows[0].session_ids)
  if (ids.includes(sessionId)) return
  ids.push(sessionId)
  await d.execute('UPDATE tasks SET session_ids = $1, updated_at = $2 WHERE id = $3', [
    JSON.stringify(ids),
    new Date().toISOString(),
    id,
  ])
}

export const setFollowupSummary = async (
  id: string,
  summary: { addressed: number; partial: number; pending: number },
) => {
  const d = await getDb()
  await d.execute('UPDATE tasks SET followup_summary = $1, updated_at = $2 WHERE id = $3', [
    JSON.stringify(summary),
    new Date().toISOString(),
    id,
  ])
}

type AlertRow = {
  key: string
  task_id: string
  kind: string
  title: string
  body: string
  read: number
  archived: number
  created_at: string
}

const toAlert = (r: AlertRow): Alert => ({
  key: r.key,
  taskId: r.task_id,
  kind: r.kind as AlertKind,
  title: r.title,
  body: r.body,
  read: r.read === 1,
  archived: r.archived === 1,
  createdAt: r.created_at,
})

export const allAlerts = async (): Promise<Alert[]> => {
  const d = await getDb()
  const rows = await d.select<AlertRow[]>('SELECT * FROM alerts WHERE archived = 0 ORDER BY created_at DESC LIMIT 100')
  return rows.map(toAlert)
}

// Reconcile the derived set against what's stored: unknown keys are inserted (and returned, so the
// caller can toast them), in-scope keys that no longer apply are deleted, and keys that persist keep
// their row — hence their read state and original created_at.
export const syncAlerts = async (scope: AlertScope, alerts: Alert[]): Promise<Alert[]> => {
  const d = await getDb()
  const stored = await d.select<AlertRow[]>('SELECT * FROM alerts')
  const known = new Set(stored.map((r) => r.key))
  const wanted = new Set(alerts.map((a) => a.key))
  const fresh: Alert[] = []
  for (const a of alerts) {
    if (known.has(a.key)) continue
    await d.execute(
      'INSERT OR IGNORE INTO alerts (key, task_id, kind, title, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [a.key, a.taskId, a.kind, a.title, a.body, a.createdAt],
    )
    fresh.push(a)
  }
  for (const r of stored.map(toAlert))
    if (!wanted.has(r.key) && inScope(r, scope)) await d.execute('DELETE FROM alerts WHERE key = $1', [r.key])
  return fresh
}

// Archived keys stay in the table on purpose: they are what stops a still-true alert from coming back.
export const archiveAlert = async (key: string) => {
  const d = await getDb()
  await d.execute('UPDATE alerts SET archived = 1, read = 1 WHERE key = $1', [key])
}

export const archiveAllAlerts = async () => {
  const d = await getDb()
  await d.execute('UPDATE alerts SET archived = 1, read = 1 WHERE archived = 0')
}

export const markAlertRead = async (key: string) => {
  const d = await getDb()
  await d.execute('UPDATE alerts SET read = 1 WHERE key = $1', [key])
}

export const markAllAlertsRead = async () => {
  const d = await getDb()
  await d.execute('UPDATE alerts SET read = 1 WHERE read = 0')
}

export const setLinks = async (id: string, sessionIds: string[], reviewFiles: string[]) => {
  const d = await getDb()
  await d.execute('UPDATE tasks SET session_ids = $1, review_files = $2 WHERE id = $3', [
    JSON.stringify(sessionIds),
    JSON.stringify(reviewFiles),
    id,
  ])
}

// ---- my_prs: the Pull Requests board -------------------------------------------------------
// Stored rather than derived, so the board paints at launch instead of after the first sync, and so
// a repo whose `gh` call failed keeps its cards instead of silently emptying its columns.

export const allMyPrs = async (): Promise<MyPr[]> => {
  const d = await getDb()
  return (await d.select<MyPrRow[]>('SELECT * FROM my_prs')).map(rowToMyPr)
}

// Write the GitHub facts and the resolved placement. `board_column` is decided by the caller
// (resolveColumn) — this only persists it.
export const upsertMyPr = async (pr: MyPr) => {
  const d = await getDb()
  await d.execute(
    `INSERT INTO my_prs (id, repo, repo_path, number, title, url, branch, pr_created_at, state, is_draft,
       human_review, bot_review, ci_state, derived_column, board_column, sort_order, done_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT(id) DO UPDATE SET
       repo_path = $3, title = $5, url = $6, branch = $7, state = $9, is_draft = $10,
       human_review = $11, bot_review = $12, ci_state = $13, derived_column = $14, board_column = $15,
       done_at = $17, updated_at = $18`,
    [
      pr.id,
      pr.repo,
      pr.repoPath,
      pr.number,
      pr.title,
      pr.url,
      pr.branch,
      pr.createdAt,
      pr.state,
      pr.isDraft ? 1 : 0,
      pr.humanReview,
      pr.botReview,
      pr.ciState,
      pr.derivedColumn,
      pr.column,
      pr.sortOrder,
      pr.doneAt,
      new Date().toISOString(),
    ],
  )
}

// A manual drop. `derived_column` is deliberately left untouched: the next sync compares GitHub's
// verdict against it, sees no change, and leaves this placement alone (src/lib/prcolumns.ts).
export const setMyPrColumn = async (id: string, column: PrColumn) => {
  const d = await getDb()
  await d.execute('UPDATE my_prs SET board_column = $1, updated_at = $2 WHERE id = $3', [
    column,
    new Date().toISOString(),
    id,
  ])
}

export const setMyPrOrders = async (orderedIds: string[]) => {
  const d = await getDb()
  for (const [i, id] of orderedIds.entries()) {
    await d.execute('UPDATE my_prs SET sort_order = $1 WHERE id = $2', [(i + 1) * 10, id])
  }
}

// Drop rows for repos that are no longer watched. Mirrors pruneRepos for the tasks table.
export const pruneMyPrRepos = async (repos: string[]) => {
  const d = await getDb()
  if (repos.length === 0) {
    await d.execute('DELETE FROM my_prs')
    return
  }
  const placeholders = repos.map((_, i) => `$${i + 1}`).join(', ')
  await d.execute(`DELETE FROM my_prs WHERE repo NOT IN (${placeholders})`, repos)
}

// Done holds only what was merged or closed today: the column answers "what did I ship today", and
// it empties itself overnight. `since` is the local start of day, as an ISO instant.
export const pruneDoneMyPrs = async (since: string) => {
  const d = await getDb()
  await d.execute("DELETE FROM my_prs WHERE state != 'open' AND (done_at IS NULL OR done_at < $1)", [since])
}

// PRs that dropped out of a repo's listing entirely (older than the closed window we ask for).
export const dropMyPrsMissingFrom = async (repo: string, keepIds: string[]) => {
  const d = await getDb()
  if (keepIds.length === 0) {
    await d.execute('DELETE FROM my_prs WHERE repo = $1', [repo])
    return
  }
  const placeholders = keepIds.map((_, i) => `$${i + 2}`).join(', ')
  await d.execute(`DELETE FROM my_prs WHERE repo = $1 AND id NOT IN (${placeholders})`, [repo, ...keepIds])
}
