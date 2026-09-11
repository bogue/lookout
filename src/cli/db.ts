import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import { type MyPrRow, rowToMyPr } from '../lib/myprrow'
import { advanceColumn } from '../lib/prcolumns'
import { advanceStage } from '../lib/stages'
import { stageUpdate, type TaskRow, toTask } from '../lib/taskrow'
import type { MyPr, PrColumn, ReviewTask, Stage } from '../types'
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
  close: () => void
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

  if (!hasTable('tasks')) throw new NoDatabaseError(`${path} has no tasks table — start the app once first`)

  // `my_prs` arrived in migration 013, so a database written by an older app won't have it. Checked
  // where it's used rather than at open, so `lookout review …` keeps working against an old database.
  const requireMyPrs = () => {
    if (!hasTable('my_prs')) {
      throw new NoDatabaseError(`${path} has no my_prs table — start this version of the app once to migrate`)
    }
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
    close: () => handle.close(),
  }
}
