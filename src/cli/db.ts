import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import { type MyPrRow, rowToMyPr } from '../lib/myprrow'
import { advanceColumn } from '../lib/prcolumns'
import { advanceStage } from '../lib/stages'
import type { DumpItem } from '../lib/stream'
import { rowToStreamItem, type StreamItemRow } from '../lib/streamrow'
import { stageUpdate, type TaskRow, toTask } from '../lib/taskrow'
import type { MyPr, PrColumn, ReviewTask, Stage, StreamItem, StreamStatus } from '../types'
import { resolveDbPath } from './paths'

// Required at call time, not imported: a static `node:sqlite` import is hoisted above everything,
// so on Node < 22.5 the process would die with ERR_UNKNOWN_BUILTIN_MODULE before the entry point
// could explain which Node it needs.
const sqlite = (): typeof import('node:sqlite') => createRequire(import.meta.url)('node:sqlite')

// The CLI never migrates: the app owns the schema (src-tauri/migrations). A missing file or a
// missing `tasks` table means "Lookout has not run here yet", which callers report as exit 3.
export class NoDatabaseError extends Error {}

export type Db = {
  // others' PRs — the review pipeline (`tasks`)
  tasks: (filter?: { repo?: string; stage?: Stage; branch?: string; prNumber?: number }) => ReviewTask[]
  task: (id: string) => ReviewTask | null
  setStage: (id: string, stage: Stage, force: boolean) => { from: Stage; to: Stage; changed: boolean }
  setSeen: (id: string, seen: boolean) => void
  clearNewActivity: (id: string) => void
  // my own PRs — the merge pipeline (`my_prs`)
  myPrs: (filter?: { repo?: string; column?: PrColumn; branch?: string; prNumber?: number }) => MyPr[]
  myPr: (id: string) => MyPr | null
  setColumn: (id: string, column: PrColumn, force: boolean) => { from: PrColumn; to: PrColumn; changed: boolean }
  // reviews with no report file behind them (`captured_reviews`, migration 014)
  saveCapturedReview: (r: CapturedReviewInput) => void
  deleteCapturedReview: (id: string) => void
  clearCapturedReviews: (before: string | null) => number
  // the Stream board (`stream_items`, migration 022)
  streamItems: (filter?: { status?: StreamStatus; repo?: string }) => StreamItem[]
  addStreamItems: (items: DumpItem[], status: 'idea' | 'queued') => string[]
  streamGate: (id: string, kind: 'result' | 'question', text: string) => 'held' | 'stopped' | false
  streamNote: (id: string, text: string) => void
  close: () => void
}

export type CapturedReviewInput = {
  id: string
  kind: 'review' | 'followup'
  taskId: string
  branch: string
  source: 'cli' | 'hook'
  sessionId: string | null
  filePath: string | null
  body: string | null
  createdAt: string
}

export const openDb = (path = resolveDbPath(), readOnly = false): Db => {
  let handle: DatabaseSync
  try {
    handle = new (sqlite().DatabaseSync)(path, { readOnly })
  } catch (e) {
    throw new NoDatabaseError(`no Lookout database at ${path} — start the app once first (${e})`)
  }
  if (!readOnly) handle.exec('PRAGMA busy_timeout = 5000') // the app holds connections too

  const hasTable = (name: string): boolean =>
    Boolean(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

  const hasColumn = (table: string, column: string): boolean =>
    handle
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => (c as { name: string }).name === column)

  if (!hasTable('tasks')) throw new NoDatabaseError(`${path} has no tasks table — start the app once first`)

  // `my_prs` arrived in migration 013, so a database written by an older app won't have it. Checked
  // where it's used rather than at open, so `lookout review …` keeps working against an old database.
  const requireMyPrs = () => {
    if (!hasTable('my_prs')) {
      throw new NoDatabaseError(`${path} has no my_prs table — start this version of the app once to migrate`)
    }
  }

  // `kind` arrived in migration 015: a CLI newer than the app it is writing for would otherwise fail
  // on the INSERT with a raw SQLite message — and say nothing at all from a hook, which swallows
  // everything. Check the column, not just the table.
  const requireCapturedReviews = () => {
    if (!hasTable('captured_reviews') || !hasColumn('captured_reviews', 'kind')) {
      throw new NoDatabaseError(`${path} is from an older Lookout — start this version of the app once to migrate`)
    }
  }

  // the Stream board arrived in migration 022
  const requireStream = () => {
    if (!hasTable('stream_items')) {
      throw new NoDatabaseError(`${path} has no Stream board yet — start this version of the app once to migrate`)
    }
  }

  // every CLI write to an item lands in its trail, signed `cli`
  const logStream = (itemId: string, kind: string, text: string | null) => {
    handle
      .prepare('INSERT INTO stream_events (item_id, ts, actor, kind, text) VALUES (?, ?, ?, ?, ?)')
      .run(itemId, new Date().toISOString(), 'cli', kind, text)
  }

  const rowsToTasks = (rows: unknown[]): ReviewTask[] => rows.map((r) => toTask(r as TaskRow))

  const task = (id: string): ReviewTask | null => {
    const row = handle.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return row ? toTask(row as TaskRow) : null
  }

  const myPr = (id: string): MyPr | null => {
    requireMyPrs()
    const row = handle.prepare('SELECT * FROM my_prs WHERE id = ?').get(id)
    return row ? rowToMyPr(row as MyPrRow) : null
  }

  return {
    tasks: (filter = {}) => {
      const where: string[] = []
      const args: (string | number)[] = []
      if (filter.repo) {
        where.push('repo = ?')
        args.push(filter.repo)
      }
      if (filter.stage) {
        where.push('stage = ?')
        args.push(filter.stage)
      }
      if (filter.branch) {
        where.push('branch = ?')
        args.push(filter.branch)
      }
      if (filter.prNumber !== undefined) {
        where.push('pr_number = ?')
        args.push(filter.prNumber)
      }
      const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`
      return rowsToTasks(handle.prepare(sql).all(...args))
    },
    task,
    // Forward-only by default (the app's own rule, src/lib/stages.ts): an automated caller can't
    // drag a card back down the pipeline. --force sets it outright.
    setStage: (id, stage, force) => {
      const current = task(id)
      if (!current) throw new Error(`no card ${id}`)
      const to = force ? stage : advanceStage(current.stage, stage)
      if (to === current.stage) return { from: current.stage, to, changed: false }
      const u = stageUpdate(to)
      handle
        .prepare('UPDATE tasks SET stage = ?, done_at = ?, updated_at = ? WHERE id = ?')
        .run(u.stage, u.done_at, u.updated_at, id)
      return { from: current.stage, to, changed: true }
    },
    setSeen: (id, seen) => {
      handle.prepare('UPDATE tasks SET seen = ? WHERE id = ?').run(seen ? 1 : 0, id)
    },
    clearNewActivity: (id) => {
      handle.prepare('UPDATE tasks SET new_activity = 0 WHERE id = ?').run(id)
    },

    myPrs: (filter = {}) => {
      requireMyPrs()
      const where: string[] = []
      const args: (string | number)[] = []
      if (filter.repo) {
        where.push('repo = ?')
        args.push(filter.repo)
      }
      if (filter.column) {
        where.push('board_column = ?')
        args.push(filter.column)
      }
      if (filter.branch) {
        where.push('branch = ?')
        args.push(filter.branch)
      }
      if (filter.prNumber !== undefined) {
        where.push('number = ?')
        args.push(filter.prNumber)
      }
      const sql = `SELECT * FROM my_prs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`
      return handle
        .prepare(sql)
        .all(...args)
        .map((r) => rowToMyPr(r as MyPrRow))
    },
    myPr,
    // What a skill hands over outright, so it wins over anything the app guessed from a transcript
    // (src/lib/db.ts keeps its own sync captures from overwriting a `cli` row).
    saveCapturedReview: (r) => {
      requireCapturedReviews()
      handle
        .prepare(
          `INSERT INTO captured_reviews (id, kind, task_id, branch, source, session_id, file_path, body, created_at, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind, task_id = excluded.task_id, branch = excluded.branch,
             source = excluded.source, session_id = excluded.session_id, file_path = excluded.file_path,
             body = excluded.body, created_at = excluded.created_at, captured_at = excluded.captured_at`,
        )
        .run(
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
        )
    },
    // the session went on to export its own report: the guess has to go, or the card shows both
    deleteCapturedReview: (id) => {
      requireCapturedReviews()
      handle.prepare('DELETE FROM captured_reviews WHERE id = ?').run(id)
    },
    clearCapturedReviews: (before) => {
      requireCapturedReviews()
      const result = before
        ? handle.prepare('DELETE FROM captured_reviews WHERE created_at < ?').run(before)
        : handle.prepare('DELETE FROM captured_reviews').run()
      return Number(result.changes)
    },
    // Forward-only by default, like setStage: the board's own rule (src/lib/prcolumns.ts), so an
    // automated caller can't knock a PR back down the merge pipeline. --force sets it outright.
    //
    // derived_column is left untouched on purpose — that is what makes the placement stick through
    // the next sync, exactly as a drag on the board does.
    setColumn: (id, column, force) => {
      const current = myPr(id)
      if (!current) throw new Error(`no PR ${id}`)
      const to = force ? column : advanceColumn(current.column, column)
      if (to === current.column) return { from: current.column, to, changed: false }
      handle
        .prepare('UPDATE my_prs SET board_column = ?, updated_at = ? WHERE id = ?')
        .run(to, new Date().toISOString(), id)
      return { from: current.column, to, changed: true }
    },
    streamItems: (filter = {}) => {
      requireStream()
      const where: string[] = []
      const args: string[] = []
      if (filter.status) {
        where.push('status = ?')
        args.push(filter.status)
      }
      if (filter.repo) {
        where.push('repo = ?')
        args.push(filter.repo)
      }
      const sql = `SELECT * FROM stream_items${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`
      return handle
        .prepare(sql)
        .all(...args)
        .map((r) => rowToStreamItem(r as StreamItemRow))
    },
    // Same shape as the app's addStreamItems (src/lib/db.ts): repo '' when nothing named the project,
    // so the app's Haiku placement picks it up; created_at a millisecond apart to keep dump order.
    addStreamItems: (items, status) => {
      requireStream()
      const base = Date.now()
      return items.map((it, i) => {
        const id = randomUUID()
        const at = new Date(base + i).toISOString()
        handle
          .prepare(
            `INSERT INTO stream_items (id, repo, title, ref_kind, ref, status, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'cli', ?, ?)`,
          )
          .run(id, it.repo ?? '', it.title, it.refKind, it.ref, status, at, at)
        logStream(id, 'created', status === 'queued' ? 'added from the CLI straight into Queued' : 'added from the CLI')
        return id
      })
    },
    // An agent stopping on purpose: a result for my review, or a question. Nothing finished moves.
    // A running card is only held: its agent is still on, and the app writes the stop when the agent's
    // final answer lands (src/lib/db.ts streamRunResult reads the held gate). Moving it now would lose
    // that answer, and leave a reply racing a live process. Any other live card stops right away.
    streamGate: (id, kind, text) => {
      requireStream()
      const held = handle.prepare("UPDATE stream_items SET gate = ? WHERE id = ? AND status = 'running'").run(kind, id)
      if (Number(held.changes)) {
        logStream(id, kind === 'question' ? 'question' : 'note', text)
        return 'held'
      }
      const status = kind === 'question' ? 'question' : 'needs_review'
      const res = handle
        .prepare(
          `UPDATE stream_items SET status = ?, gate = ?, sort_order = NULL, updated_at = ?
           WHERE id = ? AND status NOT IN ('done', 'skipped')`,
        )
        .run(status, kind, new Date().toISOString(), id)
      if (!Number(res.changes)) return false
      logStream(id, kind, text)
      return 'stopped'
    },
    streamNote: (id, text) => {
      requireStream()
      logStream(id, 'note', text)
    },
    close: () => handle.close(),
  }
}
