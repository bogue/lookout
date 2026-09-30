import Database from '@tauri-apps/plugin-sql'
import type {
  Alert,
  AlertKind,
  CapturedReview,
  CiChecks,
  MyPr,
  PrColumn,
  ReviewTask,
  Stage,
  StreamEvent,
  StreamItem,
  StreamStatus,
} from '../types'
import { type AlertScope, inScope } from './alerts'
import { logError } from './log'
import { type MyPrRow, rowToMyPr } from './myprrow'
import { columnOf, type DumpItem } from './stream'
import { rowToStreamEvent, rowToStreamItem, type StreamEventRow, type StreamItemRow } from './streamrow'
import { stageUpdate, type TaskRow, toTask } from './taskrow'

let db: Database | null = null

const getDb = async () => {
  if (!db)
    db = await Database.load('sqlite:lookout.db').catch((e) => {
      logError('db', e, 'load sqlite:lookout.db') // a locked/corrupt file leaves every board empty
      throw e
    })
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
  approved: boolean
}) => {
  const d = await getDb()
  await d.execute(
    `INSERT INTO tasks (id, repo, repo_path, branch, pr_number, pr_title, pr_url, pr_author, pr_created_at, review_requested, is_draft, updated_at, approved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT(id) DO UPDATE SET
       pr_title = $6, pr_url = $7, pr_created_at = $9, review_requested = $10, is_draft = $11, repo_path = $3, updated_at = $12,
       approved = $13`,
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
      t.approved ? 1 : 0,
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

export const setApproved = async (id: string, approved: boolean) => {
  const d = await getDb()
  await d.execute('UPDATE tasks SET approved = $1 WHERE id = $2', [approved ? 1 : 0, id])
}

export const setActivity = async (
  id: string,
  count: number,
  ciState: string | null,
  isNew: boolean,
  checks: CiChecks = null,
  conflicts = false,
) => {
  const d = await getDb()
  // new activity wakes a snoozed card
  await d.execute(
    `UPDATE tasks SET activity_count = $1, ci_state = $2, new_activity = MAX(new_activity, $3),
       snoozed = CASE WHEN $3 = 1 THEN 0 ELSE snoozed END, ci_failed = $5, ci_total = $6, conflicts = $7
     WHERE id = $4`,
    [count, ciState, isNew ? 1 : 0, id, checks?.failed ?? null, checks?.total ?? null, conflicts ? 1 : 0],
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
       human_review, bot_review, ci_state, derived_column, board_column, sort_order, done_at, updated_at, snoozed,
       ci_failed, ci_total, conflicts, approved, activity_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     ON CONFLICT(id) DO UPDATE SET
       repo_path = $3, title = $5, url = $6, branch = $7, state = $9, is_draft = $10,
       human_review = $11, bot_review = $12, ci_state = $13, derived_column = $14, board_column = $15,
       done_at = $17, updated_at = $18, snoozed = $19, ci_failed = $20, ci_total = $21, conflicts = $22,
       approved = $23, activity_count = $24`,
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
      pr.snoozed ? 1 : 0,
      pr.ciChecks?.failed ?? null,
      pr.ciChecks?.total ?? null,
      pr.conflicts ? 1 : 0,
      pr.approved ? 1 : 0,
      pr.activityCount,
    ],
  )
}

export const setMyPrSnoozed = async (id: string, snoozed: boolean) => {
  const d = await getDb()
  await d.execute('UPDATE my_prs SET snoozed = $1 WHERE id = $2', [snoozed ? 1 : 0, id])
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

// ---- gh_logins: which review/comment authors are bots (see migration 021) --------------------

export const ghLogins = async (): Promise<Map<string, boolean>> => {
  const d = await getDb()
  const rows = await d.select<{ login: string; is_bot: number }[]>('SELECT login, is_bot FROM gh_logins')
  return new Map(rows.map((r) => [r.login, r.is_bot === 1]))
}

export const saveGhLogins = async (logins: Map<string, boolean>) => {
  const d = await getDb()
  for (const [login, bot] of logins) {
    await d.execute(
      'INSERT INTO gh_logins (login, is_bot) VALUES ($1, $2) ON CONFLICT(login) DO UPDATE SET is_bot = $2',
      [login, bot ? 1 : 0],
    )
  }
}

// --- captured reviews ---------------------------------------------------------------------------
// Reviews recovered from a session transcript or registered by the CLI (see migration 014). They
// only ever feed the chat feed — no alert, no stage move.

type CapturedReviewRow = {
  id: string
  kind: string
  task_id: string
  branch: string
  source: string
  session_id: string | null
  file_path: string | null
  body: string | null
  created_at: string
}

const toCapturedReview = (r: CapturedReviewRow): CapturedReview => ({
  id: r.id,
  kind: r.kind === 'followup' ? 'followup' : 'review',
  taskId: r.task_id,
  branch: r.branch,
  source: r.source as CapturedReview['source'],
  sessionId: r.session_id,
  filePath: r.file_path,
  body: r.body,
  createdAt: r.created_at,
})

// A later pass re-captures the same session (a Stop hook fires on every turn, a sync pass re-reads a
// growing transcript), so the row is refreshed rather than duplicated — except that what the CLI
// registered is what a skill told us outright, and a guess from a transcript must not overwrite it.
export const upsertCapturedReview = async (r: Omit<CapturedReview, 'id'> & { id: string }) => {
  const d = await getDb()
  await d.execute(
    `INSERT INTO captured_reviews (id, kind, task_id, branch, source, session_id, file_path, body, created_at, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(id) DO UPDATE SET
       kind = $2, task_id = $3, branch = $4, source = $5, session_id = $6, file_path = $7, body = $8,
       created_at = $9, captured_at = $10
     WHERE captured_reviews.source != 'cli' OR excluded.source = 'cli'`,
    [
      r.id,
      r.kind,
      r.taskId,
      r.branch,
      r.source,
      r.sessionId,
      r.filePath,
      r.body,
      r.createdAt,
      new Date().toISOString(),
    ],
  )
}

export const capturedReviewsForTask = async (taskId: string): Promise<CapturedReview[]> => {
  const d = await getDb()
  const rows = await d.select<CapturedReviewRow[]>(
    'SELECT * FROM captured_reviews WHERE task_id = $1 ORDER BY created_at',
    [taskId],
  )
  return rows.map(toCapturedReview)
}

// Cards a skill registered a review for outright. Lookout does not guess alongside one: without
// this the two land under different ids — `cli:<card>` or `file:<path>` against the session id — and
// the card shows the same review twice.
export const capturedCliTaskIds = async (): Promise<Set<string>> => {
  const d = await getDb()
  const rows = await d.select<{ task_id: string }[]>("SELECT task_id FROM captured_reviews WHERE source = 'cli'")
  return new Set(rows.map((r) => r.task_id))
}

// A capture stops being true: the session went on to export its own report, or the branch turned out
// to have report files after all. Nothing else deletes a row before its 30 days are up, so without
// this the card keeps showing both the guess and the real report.
export const deleteCapturedReview = async (id: string) => {
  const d = await getDb()
  await d.execute('DELETE FROM captured_reviews WHERE id = $1', [id])
}

export const capturedReviewCount = async (): Promise<number> => {
  const d = await getDb()
  const rows = await d.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM captured_reviews')
  return rows[0]?.n ?? 0
}

export const clearCapturedReviews = async () => {
  const d = await getDb()
  await d.execute('DELETE FROM captured_reviews')
}

// Retention: a month of history, nothing older. `before` is an ISO instant.
export const pruneCapturedReviews = async (before: string) => {
  const d = await getDb()
  await d.execute('DELETE FROM captured_reviews WHERE created_at < $1', [before])
}

// ── Stream board (migration 022). An item is my own record: no sync touches these tables. ──

const logStreamEvent = async (d: Database, itemId: string, kind: string, text: string | null, actor = 'me') =>
  d.execute('INSERT INTO stream_events (item_id, ts, actor, kind, text) VALUES ($1, $2, $3, $4, $5)', [
    itemId,
    new Date().toISOString(),
    actor,
    kind,
    text,
  ])

export const streamItems = async (): Promise<StreamItem[]> => {
  const d = await getDb()
  const rows = await d.select<StreamItemRow[]>('SELECT * FROM stream_items ORDER BY created_at')
  return rows.map(rowToStreamItem)
}

export const streamEvents = async (itemId: string): Promise<StreamEvent[]> => {
  const d = await getDb()
  const rows = await d.select<StreamEventRow[]>('SELECT * FROM stream_events WHERE item_id = $1 ORDER BY id', [itemId])
  return rows.map(rowToStreamEvent)
}

// A dump's items, in dump order: created_at is spaced by a millisecond so "oldest first" in Queued
// keeps the order I typed them in even though they land in the same instant.
export const addStreamItems = async (repo: string, items: DumpItem[], status: StreamStatus) => {
  const d = await getDb()
  const base = Date.now()
  for (const [i, it] of items.entries()) {
    const id = crypto.randomUUID()
    const at = new Date(base + i).toISOString()
    await d.execute(
      `INSERT INTO stream_items (id, repo, title, ref_kind, ref, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [id, repo, it.title, it.refKind, it.ref, status, at],
    )
    await logStreamEvent(d, id, 'created', status === 'queued' ? 'dumped straight into Queued' : null)
  }
}

// A status change. Entering another column resets the card's rank to `entryRank` there (stream.ts):
// on top of Done, unranked elsewhere. The caller re-ranks the whole column right after a drag.
export const setStreamStatus = async (item: StreamItem, status: StreamStatus, rank: number | null = null) => {
  if (status === item.status) return
  const d = await getDb()
  const sameColumn = columnOf(status) === columnOf(item.status)
  await d.execute(
    `UPDATE stream_items SET status = $1, updated_at = $2${sameColumn ? '' : ', sort_order = $4'} WHERE id = $3`,
    sameColumn ? [status, new Date().toISOString(), item.id] : [status, new Date().toISOString(), item.id, rank],
  )
  await logStreamEvent(d, item.id, 'status', `${item.status} → ${status}`)
}

// A column's full order after a drag (or Move to top/bottom): every card in it gets a rank. One
// statement, so a failure can't leave the column half re-ranked with old and new ranks mixed.
export const setStreamOrders = async (orderedIds: string[]) => {
  if (!orderedIds.length) return
  const d = await getDb()
  const cases = orderedIds.map((_, i) => `WHEN $${i + 1} THEN ${(i + 1) * 10}`).join(' ')
  const ids = orderedIds.map((_, i) => `$${i + 1}`).join(', ')
  await d.execute(`UPDATE stream_items SET sort_order = CASE id ${cases} END WHERE id IN (${ids})`, orderedIds)
}

// back to the column's default order, and hand the priority chip back to Haiku
export const resetStreamPriority = async (id: string) => {
  const d = await getDb()
  await d.execute(
    'UPDATE stream_items SET sort_order = NULL, priority = NULL, priority_reason = NULL, priority_source = NULL WHERE id = $1',
    [id],
  )
  await logStreamEvent(d, id, 'priority', 'reset to the default order')
}

// updated_at stays: it is when the status last changed (how long it waited on me, when it finished)
export const editStreamItem = async (id: string, fields: { title: string; body: string | null }) => {
  const d = await getDb()
  await d.execute('UPDATE stream_items SET title = $1, body = $2 WHERE id = $3', [fields.title, fields.body, id])
  await logStreamEvent(d, id, 'edited', null)
}

export const removeStreamItem = async (id: string) => {
  const d = await getDb()
  await d.execute('DELETE FROM stream_events WHERE item_id = $1', [id])
  await d.execute('DELETE FROM stream_items WHERE id = $1', [id])
}
