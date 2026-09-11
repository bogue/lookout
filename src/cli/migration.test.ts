import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openDb } from './db'

// The app applies these on launch (src-tauri/src/lib.rs). Replaying them here means a migration that
// doesn't do what it claims fails in CI rather than on someone's board.
const MIGRATIONS = join(import.meta.dirname, '..', '..', 'src-tauri', 'migrations')
const files = (): string[] => readdirSync(MIGRATIONS).sort()

const applyThrough = (db: DatabaseSync, lastVersion: number) => {
  for (const name of files()) {
    if (Number(name.slice(0, 3)) > lastVersion) continue
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'))
  }
}

const apply = (db: DatabaseSync, name: string) => db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'))

describe('012_needs_review', () => {
  it('renames stage inbox to needs_review and leaves every other stage alone', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lookout-migrate-')), 'lookout.db')
    const h = new DatabaseSync(path)
    applyThrough(h, 11)

    const insert = h.prepare(
      `INSERT INTO tasks (id, repo, branch, pr_number, pr_title, pr_url, pr_author, stage, updated_at)
       VALUES (?, 'owner/repo', 'b', ?, 't', 'u', 'a', ?, '2026-09-01T00:00:00.000Z')`,
    )
    insert.run('owner/repo#1', 1, 'inbox')
    insert.run('owner/repo#2', 2, 'reviewing')
    insert.run('owner/repo#3', 3, 'done')

    apply(h, '012_needs_review.sql')
    const stages = (h.prepare('SELECT id, stage FROM tasks ORDER BY id').all() as { id: string; stage: string }[]).map(
      (r) => r.stage,
    )
    h.close()

    expect(stages).toEqual(['needs_review', 'reviewing', 'done'])
  })

  it('leaves a database that never had an inbox card untouched', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lookout-migrate-')), 'lookout.db')
    const h = new DatabaseSync(path)
    applyThrough(h, 11)
    h.prepare(
      `INSERT INTO tasks (id, repo, branch, pr_number, pr_title, pr_url, pr_author, stage, updated_at)
       VALUES ('owner/repo#1', 'owner/repo', 'b', 1, 't', 'u', 'a', 'watching', '2026-09-01T00:00:00.000Z')`,
    ).run()
    apply(h, '012_needs_review.sql')
    h.close()

    const db = openDb(path, true)
    expect(db.tasks().map((t) => t.stage)).toEqual(['watching'])
    db.close()
  })

  it('is registered with the app, or it never runs', () => {
    const lib = readFileSync(join(import.meta.dirname, '..', '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
    for (const name of files()) {
      expect(lib).toContain(`migrations/${name}`)
    }
  })
})

describe('013_my_prs', () => {
  const open013 = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lookout-migrate-')), 'lookout.db')
    const h = new DatabaseSync(path)
    applyThrough(h, 13)
    return h
  }

  const insert = (h: DatabaseSync, id: string, state: string, doneAt: string | null, column = 'done') =>
    h
      .prepare(
        `INSERT INTO my_prs (id, repo, number, title, url, branch, pr_created_at, state,
           derived_column, board_column, done_at, updated_at)
         VALUES (?, 'owner/repo', 1, 't', 'u', 'b', '2026-09-01T00:00:00.000Z', ?, ?, ?, ?,
           '2026-09-11T00:00:00.000Z')`,
      )
      .run(id, state, column, column, doneAt)

  it('creates my_prs with a placement that survives a restart', () => {
    const h = open013()
    insert(h, 'owner/repo#1', 'open', null, 'in_review')
    const row = h.prepare('SELECT board_column, derived_column FROM my_prs').get() as Record<string, string>
    h.close()
    // the pair is the whole point: board_column is the placement, derived_column the change detector
    expect(row.board_column).toBe('in_review')
    expect(row.derived_column).toBe('in_review')
  })

  // mirrors pruneDoneMyPrs in src/lib/db.ts — that runs through tauri-plugin-sql, which can't be
  // exercised here, so the query itself is replayed to pin its semantics
  const PRUNE = "DELETE FROM my_prs WHERE state != 'open' AND (done_at IS NULL OR done_at < ?)"

  it("keeps open PRs and today's merges, drops yesterday's", () => {
    const h = open013()
    insert(h, 'owner/repo#1', 'open', null, 'waiting')
    insert(h, 'owner/repo#2', 'merged', '2026-09-11T09:00:00.000Z')
    insert(h, 'owner/repo#3', 'closed', '2026-09-11T23:00:00.000Z')
    insert(h, 'owner/repo#4', 'merged', '2026-09-10T23:59:00.000Z')

    h.prepare(PRUNE).run('2026-09-11T00:00:00.000Z')
    const kept = (h.prepare('SELECT id FROM my_prs ORDER BY id').all() as { id: string }[]).map((r) => r.id)
    h.close()

    expect(kept).toEqual(['owner/repo#1', 'owner/repo#2', 'owner/repo#3'])
  })

  it('drops a merged row with no timestamp rather than keeping it forever', () => {
    const h = open013()
    insert(h, 'owner/repo#1', 'merged', null)
    h.prepare(PRUNE).run('2026-09-11T00:00:00.000Z')
    const n = (h.prepare('SELECT count(*) AS n FROM my_prs').get() as { n: number }).n
    h.close()
    expect(n).toBe(0)
  })
})
