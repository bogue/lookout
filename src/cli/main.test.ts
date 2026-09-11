import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, run } from './main'

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'src-tauri', 'migrations')

let dbPath: string
let out: string[]
let err: string[]

// The CLI reads the DB path from the environment, and the whole point of $LOOKOUT_DB is that the
// tests never touch the real one.
const cli = (...argv: string[]) =>
  run(
    argv,
    (s) => out.push(String(s)),
    (s) => err.push(String(s)),
  )

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'lookout-cli-')), 'lookout.db')
  const h = new DatabaseSync(dbPath)
  for (const name of readdirSync(MIGRATIONS).sort()) h.exec(readFileSync(join(MIGRATIONS, name), 'utf8'))
  h.prepare(
    `INSERT INTO tasks (id, repo, repo_path, branch, pr_number, pr_title, pr_url, pr_author, stage, updated_at)
     VALUES ('owner/repo#42', 'owner/repo', '/tmp/repo', 'feature-x', 42, 'A title',
             'https://github.com/owner/repo/pull/42', 'someone', 'reviewing', '2026-09-01T00:00:00.000Z')`,
  ).run()
  h.close()
  process.env.LOOKOUT_DB = dbPath
  // no socket pointer in the test env: notifyApp must stay silent
  process.env.HOME = join(mkdtempSync(join(tmpdir(), 'lookout-home-')))
  out = []
  err = []
})

afterEach(() => {
  delete process.env.LOOKOUT_DB
})

const seedMyPr = (id: string, column: string, branch = 'my-feature', number = 7) => {
  const h = new DatabaseSync(dbPath)
  h.prepare(
    `INSERT INTO my_prs (id, repo, repo_path, number, title, url, branch, pr_created_at, state,
       ci_state, derived_column, board_column, updated_at)
     VALUES (?, 'owner/repo', '/tmp/repo', ?, 'My PR', 'https://github.com/owner/repo/pull/7', ?,
       '2026-09-01T00:00:00.000Z', 'open', 'pass', ?, ?, '2026-09-01T00:00:00.000Z')`,
  ).run(id, number, branch, column, column)
  h.close()
}

const columnOf = (id: string): string => {
  const h = new DatabaseSync(dbPath)
  const row = h.prepare('SELECT board_column FROM my_prs WHERE id = ?').get(id) as { board_column: string }
  h.close()
  return row.board_column
}

const stageOf = (id: string): string => {
  const h = new DatabaseSync(dbPath)
  const row = h.prepare('SELECT stage FROM tasks WHERE id = ?').get(id) as { stage: string }
  h.close()
  return row.stage
}

describe('help and unknown commands', () => {
  it('prints usage with no arguments', () => {
    expect(cli()).toBe(EXIT.ok)
    expect(out.join('')).toContain('lookout review list')
  })

  it('rejects an unknown command', () => {
    expect(cli('frobnicate')).toBe(EXIT.error)
    expect(err.join('')).toContain('unknown command')
  })

  it('rejects an unknown stage', () => {
    expect(cli('card', 'stage', 'nope', '--card', 'owner/repo#42')).toBe(EXIT.error)
    expect(err.join('')).toContain('unknown stage')
  })

  it('accepts the follow-up verb the way the board spells it', () => {
    expect(cli('card', 'follow-up', '--card', 'owner/repo#42')).toBe(EXIT.ok)
  })
})

describe('review list / show', () => {
  it('lists cards with UI stage labels, not ids', () => {
    expect(cli('card', 'list')).toBe(EXIT.ok)
    expect(out.join('')).toContain('In Review')
  })

  it('emits json when asked', () => {
    expect(cli('card', 'list', '--json')).toBe(EXIT.ok)
    expect(JSON.parse(out.join(''))).toEqual([
      expect.objectContaining({ id: 'owner/repo#42', stage: 'reviewing', stage_label: 'In Review' }),
    ])
  })

  it('shows one card by pr number', () => {
    expect(cli('card', 'show', '--pr', '42')).toBe(EXIT.ok)
    expect(out.join('')).toContain('https://github.com/owner/repo/pull/42')
  })

  it('exits 2 when nothing matches', () => {
    expect(cli('card', 'show', '--pr', '999')).toBe(EXIT.noMatch)
    expect(err.join('')).toContain('no card for PR #999')
  })
})

describe('stage moves', () => {
  // The board says "Needs Review" and so does the stored id now; the retired `inbox` still works.
  it('takes the name the board shows', () => {
    expect(cli('card', 'stage', 'needs-review', '--card', 'owner/repo#42', '--force')).toBe(EXIT.ok)
    expect(stageOf('owner/repo#42')).toBe('needs_review')
    expect(out.join('')).toContain('→ Needs Review')
  })

  it('takes the label with its spaces and case', () => {
    expect(cli('card', 'stage', 'In Review', '--card', 'owner/repo#42', '--force')).toBe(EXIT.ok)
    expect(stageOf('owner/repo#42')).toBe('reviewing')
  })

  it('still takes the retired inbox id', () => {
    expect(cli('card', 'stage', 'inbox', '--card', 'owner/repo#42', '--force')).toBe(EXIT.ok)
    expect(stageOf('owner/repo#42')).toBe('needs_review')
  })

  it('lists the board names when the stage is unknown', () => {
    expect(cli('card', 'stage', 'nope', '--card', 'owner/repo#42')).toBe(EXIT.error)
    expect(err.join('')).toContain('needs-review')
  })

  it('filters a listing by board name too', () => {
    expect(cli('card', 'list', '--stage', 'In Review', '--json')).toBe(EXIT.ok)
    expect(JSON.parse(out.join('')).length).toBe(1)
  })

  it('card reviewed moves the card and says so', () => {
    expect(cli('card', 'reviewed', '--card', 'owner/repo#42')).toBe(EXIT.ok)
    expect(stageOf('owner/repo#42')).toBe('reviewed')
    expect(out.join('')).toBe('owner/repo#42: In Review → Reviewed')
  })

  it('is a no-op the second time', () => {
    cli('card', 'reviewed', '--card', 'owner/repo#42')
    out = []
    expect(cli('card', 'reviewed', '--card', 'owner/repo#42')).toBe(EXIT.ok)
    expect(out.join('')).toContain('already Reviewed')
  })

  it('--dry-run writes nothing', () => {
    expect(cli('card', 'done', '--card', 'owner/repo#42', '--dry-run')).toBe(EXIT.ok)
    expect(stageOf('owner/repo#42')).toBe('reviewing')
    expect(out.join('')).toContain('would move')
  })

  it('--quiet prints nothing but still acts', () => {
    expect(cli('card', 'reviewed', '--card', 'owner/repo#42', '--quiet')).toBe(EXIT.ok)
    expect(out).toEqual([])
    expect(stageOf('owner/repo#42')).toBe('reviewed')
  })

  it('respects forward-only unless forced', () => {
    cli('card', 'done', '--card', 'owner/repo#42')
    expect(cli('card', 'reviewed', '--card', 'owner/repo#42')).toBe(EXIT.ok)
    expect(stageOf('owner/repo#42')).toBe('done')
    expect(cli('card', 'reviewed', '--card', 'owner/repo#42', '--force')).toBe(EXIT.ok)
    expect(stageOf('owner/repo#42')).toBe('reviewed')
  })
})

describe('comments-pushed', () => {
  it('moves to reviewed and clears the unread markers', () => {
    const h = new DatabaseSync(dbPath)
    h.exec("UPDATE tasks SET new_activity = 1, seen = 0 WHERE id = 'owner/repo#42'")
    h.close()

    expect(cli('card', 'comments-pushed', '--card', 'owner/repo#42', '--count', '3', '--json')).toBe(EXIT.ok)
    expect(JSON.parse(out.join(''))).toMatchObject({ stage: 'reviewed', moved: true })

    const after = new DatabaseSync(dbPath)
    const row = after.prepare("SELECT new_activity, seen FROM tasks WHERE id = 'owner/repo#42'").get() as {
      new_activity: number
      seen: number
    }
    after.close()
    expect(row).toEqual({ new_activity: 0, seen: 1 })
    expect(stageOf('owner/repo#42')).toBe('reviewed')
  })

  it('requires --count', () => {
    expect(cli('card', 'comments-pushed', '--card', 'owner/repo#42')).toBe(EXIT.error)
    expect(err.join('')).toContain('--count')
  })
})

describe('doctor', () => {
  it('reports the database and both board counts', () => {
    expect(cli('doctor')).toBe(EXIT.ok)
    expect(out.join('')).toContain('review    1 cards')
    expect(out.join('')).toContain('mine      0 pull requests')
  })

  it('exits 3 when the app has never run', () => {
    process.env.LOOKOUT_DB = join(tmpdir(), 'definitely-not-here', 'lookout.db')
    expect(cli('doctor')).toBe(EXIT.noDb)
    expect(out.join('')).toContain('not found')
  })
})

describe('the built binary', () => {
  it('runs end to end and returns the documented exit code', () => {
    // the npm script, not vite directly: it also chmods the output, which is what makes the
    // shebang usable — building around it would hide a broken binary
    execFileSync('npm', ['run', 'build:cli'], { stdio: 'ignore', cwd: join(import.meta.dirname, '..', '..') })
    const bin = join(import.meta.dirname, '..', '..', 'dist-cli', 'lookout.mjs')
    // executed directly, so the shebang and the exec bit are both exercised
    const text = execFileSync(bin, ['card', 'show', '--pr', '42'], {
      encoding: 'utf8',
      env: { ...process.env, LOOKOUT_DB: dbPath },
    })
    expect(text).toContain('owner/repo#42')
    expect(text).toContain('stage      In Review')
  }, 60_000)
})

describe('lookout review — the old `card` spelling still works', () => {
  it('accepts both names for the same command', () => {
    expect(cli('review', 'list')).toBe(EXIT.ok)
    const viaReview = out.join('')
    out = []
    expect(cli('card', 'list')).toBe(EXIT.ok)
    expect(out.join('')).toBe(viaReview)
  })

  it('moves a card under either name', () => {
    expect(cli('card', 'reviewed', '--id', 'owner/repo#42')).toBe(EXIT.ok)
    expect(stageOf('owner/repo#42')).toBe('reviewed')
  })

  it('still takes the old --card selector flag', () => {
    expect(cli('review', 'show', '--card', 'owner/repo#42')).toBe(EXIT.ok)
    expect(out.join('')).toContain('owner/repo#42')
  })

  it('names the group it did not understand', () => {
    expect(cli('mine', 'frobnicate')).toBe(EXIT.error)
    expect(err.join('')).toContain('unknown mine command')
  })
})

describe('lookout mine — my own PRs', () => {
  it('lists nothing when the board is empty', () => {
    expect(cli('mine', 'list')).toBe(EXIT.ok)
    expect(out.join('')).toContain('(no pull requests)')
  })

  it('lists a PR with its column and CI', () => {
    seedMyPr('owner/repo#7', 'ready')
    expect(cli('mine', 'list')).toBe(EXIT.ok)
    expect(out.join('')).toContain('owner/repo#7')
    expect(out.join('')).toContain('Ready to merge')
    expect(out.join('')).toContain('pass')
  })

  it('filters by column', () => {
    seedMyPr('owner/repo#7', 'ready')
    seedMyPr('owner/repo#8', 'waiting', 'other', 8)
    expect(cli('mine', 'list', '--column', 'ready')).toBe(EXIT.ok)
    expect(out.join('')).toContain('owner/repo#7')
    expect(out.join('')).not.toContain('owner/repo#8')
  })

  it('shows one PR', () => {
    seedMyPr('owner/repo#7', 'in_review')
    expect(cli('mine', 'show', '--id', 'owner/repo#7')).toBe(EXIT.ok)
    expect(out.join('')).toContain('column     In Review')
  })

  it('moves a PR forward with the sugar verb', () => {
    seedMyPr('owner/repo#7', 'waiting')
    expect(cli('mine', 'ready', '--id', 'owner/repo#7')).toBe(EXIT.ok)
    expect(columnOf('owner/repo#7')).toBe('ready')
  })

  it('accepts the board label as well as the id', () => {
    seedMyPr('owner/repo#7', 'waiting')
    expect(cli('mine', 'column', 'Ready to merge', '--id', 'owner/repo#7')).toBe(EXIT.ok)
    expect(columnOf('owner/repo#7')).toBe('ready')
  })

  it('refuses to move a PR backwards without --force', () => {
    seedMyPr('owner/repo#7', 'ready')
    expect(cli('mine', 'waiting', '--id', 'owner/repo#7')).toBe(EXIT.ok)
    expect(columnOf('owner/repo#7')).toBe('ready')
    expect(out.join('')).toContain('no change')
  })

  it('moves it backwards with --force', () => {
    seedMyPr('owner/repo#7', 'ready')
    expect(cli('mine', 'waiting', '--id', 'owner/repo#7', '--force')).toBe(EXIT.ok)
    expect(columnOf('owner/repo#7')).toBe('waiting')
  })

  it('leaves derived_column alone, so the placement survives the next sync', () => {
    seedMyPr('owner/repo#7', 'waiting')
    cli('mine', 'ready', '--id', 'owner/repo#7')
    const h = new DatabaseSync(dbPath)
    const row = h.prepare('SELECT derived_column FROM my_prs WHERE id = ?').get('owner/repo#7') as {
      derived_column: string
    }
    h.close()
    expect(row.derived_column).toBe('waiting')
  })

  it('writes nothing on --dry-run', () => {
    seedMyPr('owner/repo#7', 'waiting')
    expect(cli('mine', 'ready', '--id', 'owner/repo#7', '--dry-run')).toBe(EXIT.ok)
    expect(columnOf('owner/repo#7')).toBe('waiting')
    expect(out.join('')).toContain('would move')
  })

  it('resolves by PR number', () => {
    seedMyPr('owner/repo#7', 'waiting')
    expect(cli('mine', 'show', '--pr', '7', '--repo', 'owner/repo')).toBe(EXIT.ok)
    expect(out.join('')).toContain('owner/repo#7')
  })

  it('exits noMatch when nothing matches', () => {
    expect(cli('mine', 'show', '--id', 'owner/repo#404')).toBe(EXIT.noMatch)
  })

  it('rejects an unknown column', () => {
    seedMyPr('owner/repo#7', 'waiting')
    expect(cli('mine', 'column', 'nowhere', '--id', 'owner/repo#7')).toBe(EXIT.error)
    expect(err.join('')).toContain('unknown column')
  })

  it('emits json', () => {
    seedMyPr('owner/repo#7', 'ready')
    expect(cli('mine', 'list', '--json')).toBe(EXIT.ok)
    expect(JSON.parse(out.join(''))[0]).toMatchObject({ id: 'owner/repo#7', column: 'ready', ci_state: 'pass' })
  })
})
