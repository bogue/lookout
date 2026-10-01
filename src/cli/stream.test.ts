import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, run } from './main'

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'src-tauri', 'migrations')

let dbPath: string
let out: string[]
let err: string[]
let stdin = ''

const cli = (...argv: string[]) =>
  run(
    argv,
    (s) => out.push(String(s)),
    (s) => err.push(String(s)),
    () => stdin,
  )

const rows = (sql: string, ...args: string[]) => {
  const h = new DatabaseSync(dbPath)
  const r = h.prepare(sql).all(...args)
  h.close()
  return r as Record<string, unknown>[]
}

const seed = (id: string, status: string, checkout: string | null = null, repo = 'owner/app') => {
  const h = new DatabaseSync(dbPath)
  h.prepare(
    `INSERT INTO stream_items (id, repo, title, status, checkout, created_at, updated_at)
     VALUES (?, ?, 'implement card 1', ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  ).run(id, repo, status, checkout)
  h.close()
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'lookout-cli-')), 'lookout.db')
  const h = new DatabaseSync(dbPath)
  for (const name of readdirSync(MIGRATIONS).sort()) h.exec(readFileSync(join(MIGRATIONS, name), 'utf8'))
  h.close()
  // the app's config sits next to its database: the CLI reads the watched projects from it
  writeFileSync(
    join(dirname(dbPath), 'config.json'),
    JSON.stringify({
      repos: [
        { repo: 'owner/app', path: '/tmp/app' },
        { repo: 'acme/api', path: '/tmp/api' },
      ],
    }),
  )
  process.env.LOOKOUT_DB = dbPath
  process.env.HOME = mkdtempSync(join(tmpdir(), 'lookout-home-')) // no socket pointer: notifyApp stays silent
  out = []
  err = []
  stdin = ''
})

afterEach(() => {
  delete process.env.LOOKOUT_DB
})

describe('lookout stream add', () => {
  it('dumps a line into Inbox, split per target, under the --repo project', () => {
    expect(cli('stream', 'add', 'implement card 1,2', '--repo', 'acme/api')).toBe(EXIT.ok)
    const items = rows('SELECT repo, title, status, created_by FROM stream_items ORDER BY created_at')
    expect(items).toEqual([
      { repo: 'acme/api', title: 'implement card 1', status: 'idea', created_by: 'cli' },
      { repo: 'acme/api', title: 'implement card 2', status: 'idea', created_by: 'cli' },
    ])
    expect(rows("SELECT actor FROM stream_events WHERE kind = 'created'").map((r) => r.actor)).toEqual(['cli', 'cli'])
  })

  it('reads #project tags against the watched projects, and --queue lands it in Queued', () => {
    expect(cli('stream', 'add', '#app', 'bump', 'deps', '--queue')).toBe(EXIT.ok)
    expect(rows('SELECT repo, title, status FROM stream_items')).toEqual([
      { repo: 'owner/app', title: 'bump deps', status: 'queued' },
    ])
  })

  it('leaves the project for the app to place when nothing names it', () => {
    cli('stream', 'add', 'something vague')
    expect(rows('SELECT repo FROM stream_items')).toEqual([{ repo: '' }])
  })

  it('takes the text from stdin', () => {
    stdin = 'fix login\nwrite docs\n'
    expect(cli('stream', 'add', '--stdin', '--repo', 'owner/app')).toBe(EXIT.ok)
    expect(rows('SELECT title FROM stream_items ORDER BY created_at').map((r) => r.title)).toEqual([
      'fix login',
      'write docs',
    ])
  })

  it('refuses an empty dump', () => {
    expect(cli('stream', 'add')).toBe(EXIT.error)
  })
})

describe('lookout stream list', () => {
  it('lists items, filtered by status', () => {
    seed('aaaaaaaa-1', 'queued')
    seed('bbbbbbbb-2', 'done')
    expect(cli('stream', 'list', '--status', 'queued', '--json')).toBe(EXIT.ok)
    expect(JSON.parse(out[0]).map((x: { id: string }) => x.id)).toEqual(['aaaaaaaa-1'])
  })
})

describe('lookout stream gate', () => {
  it('stops a running item for my review with the summary as its result', () => {
    seed('aaaaaaaa-1', 'running')
    expect(cli('stream', 'gate', '--item', 'aaaaaaaa', '--summary', 'Plan ready: 3 files')).toBe(EXIT.ok)
    expect(rows('SELECT status, gate FROM stream_items')).toEqual([{ status: 'needs_review', gate: 'result' }])
    expect(rows("SELECT actor, text FROM stream_events WHERE kind = 'result'")).toEqual([
      { actor: 'cli', text: 'Plan ready: 3 files' },
    ])
  })

  it('asks me a question', () => {
    seed('aaaaaaaa-1', 'running')
    expect(cli('stream', 'gate', '--item', 'aaaaaaaa-1', '--kind', 'question', '--summary', 'v1 or v2 API?')).toBe(
      EXIT.ok,
    )
    expect(rows('SELECT status, gate FROM stream_items')).toEqual([{ status: 'question', gate: 'question' }])
  })

  it('finds the item from the worktree it runs in', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'lookout-wt-'))
    seed('aaaaaaaa-1', 'running', checkout)
    const cwd = process.cwd()
    process.chdir(checkout)
    try {
      expect(cli('stream', 'gate', '--summary', 'done here')).toBe(EXIT.ok)
    } finally {
      process.chdir(cwd)
    }
    expect(rows('SELECT status FROM stream_items')).toEqual([{ status: 'needs_review' }])
  })

  it('leaves a finished item alone', () => {
    seed('aaaaaaaa-1', 'done')
    expect(cli('stream', 'gate', '--item', 'aaaaaaaa', '--summary', 'late')).toBe(EXIT.error)
    expect(rows('SELECT status FROM stream_items')).toEqual([{ status: 'done' }])
  })

  it('says no match for an unknown item', () => {
    expect(cli('stream', 'gate', '--item', 'zzzzzzzz', '--summary', 'x')).toBe(EXIT.noMatch)
  })

  it('needs a summary', () => {
    seed('aaaaaaaa-1', 'running')
    expect(cli('stream', 'gate', '--item', 'aaaaaaaa')).toBe(EXIT.error)
  })
})

describe('lookout stream note', () => {
  it('adds a note to the item trail without moving it', () => {
    seed('aaaaaaaa-1', 'running')
    expect(cli('stream', 'note', '--item', 'aaaaaaaa', 'tests', 'are', 'slow')).toBe(EXIT.ok)
    expect(rows("SELECT actor, text FROM stream_events WHERE kind = 'note'")).toEqual([
      { actor: 'cli', text: 'tests are slow' },
    ])
    expect(rows('SELECT status FROM stream_items')).toEqual([{ status: 'running' }])
  })
})
