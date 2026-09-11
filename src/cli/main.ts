import { PR_COLUMNS } from '../lib/prboard'
import { parseStage, STAGE_LABEL, STAGES } from '../lib/stages'
import type { MyPr, PrColumn, ReviewTask, Stage } from '../types'
import { type Args, flagNumber, flagString, parseArgs } from './args'
import { type Db, NoDatabaseError, openDb } from './db'
import { notifyApp } from './notify'
import { resolveDbPath } from './paths'
import { AmbiguousError, NoMatchError, resolveCard, resolveMyPr, type Selector } from './resolve'

// Exit codes are the CLI's contract with skills: 2 and 3 mean "nothing to do here", not failure.
export const EXIT = { ok: 0, error: 1, noMatch: 2, noDb: 3, ambiguous: 4 } as const

// What a stage looks like when typed: the board's own name, dash-joined. `inbox` and the other
// stored ids still work — parseStage takes either — but the help shows what the UI shows.
const STAGE_NAMES = STAGES.map((s) => s.label.toLowerCase().replace(/ /g, '-'))

const readStage = (input: string): Stage => {
  const stage = parseStage(input)
  if (!stage) throw new Error(`unknown stage "${input}" — expected one of: ${STAGE_NAMES.join(', ')}`)
  return stage
}

// The two boards hold different work, and the command name is what says which: `review` is other
// people's PRs (the review pipeline), `mine` is my own (the merge pipeline). `card` still works —
// nothing can rewrite what someone already typed into a shell alias or a skill.
const REVIEW_ALIASES = ['review', 'card']

// Column names as typed: what the board calls them, dash-joined.
const COLUMN_NAMES = PR_COLUMNS.map((c) => c.value.replace(/_/g, '-'))
const COLUMN_LABEL: Record<PrColumn, string> = Object.fromEntries(PR_COLUMNS.map((c) => [c.value, c.label])) as Record<
  PrColumn,
  string
>

const readColumn = (input: string): PrColumn => {
  const key = input.toLowerCase().replace(/[^a-z0-9]/g, '')
  const found = PR_COLUMNS.find(
    (c) => c.value.replace(/[^a-z0-9]/g, '') === key || c.label.toLowerCase().replace(/[^a-z0-9]/g, '') === key,
  )
  if (!found) throw new Error(`unknown column "${input}" — expected one of: ${COLUMN_NAMES.join(', ')}`)
  return found.value
}

// `lookout mine ready` and friends — sugar for `mine column <column>`.
const VERB_COLUMN: Record<string, PrColumn> = {
  waiting: 'waiting',
  'in-review': 'in_review',
  review: 'in_review',
  ready: 'ready',
  merged: 'done',
  done: 'done',
}

// `lookout review reviewed` and friends — sugar for `review stage <stage>`.
const VERB_STAGE: Record<string, Stage> = {
  reviewed: 'reviewed',
  'follow-up': 'followup',
  followup: 'followup',
  done: 'done',
  watch: 'watching',
  ignore: 'ignored',
}

const USAGE = `lookout — move Lookout cards from the terminal

other people's PRs — the review pipeline

  lookout review list [--stage <s>] [--repo <r>]
  lookout review show [selector]
  lookout review stage <${STAGE_NAMES.join(' | ')}> [selector] [--force]
  lookout review reviewed | follow-up | done | watch | ignore [selector]
  lookout review comments-pushed [selector] --count <n> [--numbers 1,3] [--url <u>]

your own PRs — the merge pipeline

  lookout mine list [--column <c>] [--repo <r>]
  lookout mine show [selector]
  lookout mine column <${COLUMN_NAMES.join(' | ')}> [selector] [--force]
  lookout mine waiting | in-review | ready | done [selector]

  lookout doctor

selector   --id <id> | --pr <n> | --branch <b> [--repo <owner/repo>]
           defaults to the PR for the current repo + branch
options    --json   machine-readable output
           --quiet  print nothing (exit code only)
           --dry-run  resolve and report, write nothing
           --force  move backwards down a pipeline (both default to forward-only)

\`lookout card …\` is the old name for \`lookout review …\` and still works.
`

type Ctx = {
  args: Args
  json: boolean
  quiet: boolean
  dryRun: boolean
  out: (human: string, data: unknown) => void
}

const selectorFrom = (args: Args): Selector => ({
  id: flagString(args.flags, 'id') ?? flagString(args.flags, 'card'), // --card: the old spelling
  pr: flagNumber(args.flags, 'pr'),
  branch: flagString(args.flags, 'branch'),
  repo: flagString(args.flags, 'repo'),
})

const line = (t: ReviewTask): string => `${t.id.padEnd(34)} ${STAGE_LABEL[t.stage].padEnd(13)} ${t.branch}`

const cardJson = (t: ReviewTask) => ({
  id: t.id,
  repo: t.repo,
  repo_path: t.repoPath,
  branch: t.branch,
  pr_number: t.prNumber,
  pr_url: t.prUrl,
  pr_state: t.prState,
  stage: t.stage,
  stage_label: STAGE_LABEL[t.stage],
})

// A stage move, shared by `review stage` and every sugar verb.
const moveStage = (db: Db, ctx: Ctx, target: Stage, extra?: (id: string) => void): number => {
  const card = resolveCard(db, selectorFrom(ctx.args))
  if (ctx.dryRun) {
    ctx.out(`would move ${card.id}: ${STAGE_LABEL[card.stage]} → ${STAGE_LABEL[target]}`, {
      ...cardJson(card),
      would_move_to: target,
      dry_run: true,
    })
    return EXIT.ok
  }
  const move = db.setStage(card.id, target, ctx.args.flags.force === true || ctx.args.flags.force === 'true')
  extra?.(card.id)
  const human = move.changed
    ? `${card.id}: ${STAGE_LABEL[move.from]} → ${STAGE_LABEL[move.to]}`
    : `${card.id}: already ${STAGE_LABEL[move.to]} (no change)`
  ctx.out(human, { ...cardJson(card), stage: move.to, stage_label: STAGE_LABEL[move.to], moved: move.changed })
  if (move.changed) notifyApp({ kind: 'cards.changed', ids: [card.id], source: 'cli' })
  return EXIT.ok
}

const reviewCommand = (db: Db, ctx: Ctx): number => {
  const [, sub, arg] = ctx.args.path

  if (!sub || sub === 'list') {
    const asked = flagString(ctx.args.flags, 'stage')
    const stage = asked === undefined ? undefined : readStage(asked)
    const tasks = db.tasks({ stage, repo: flagString(ctx.args.flags, 'repo') })
    ctx.out(tasks.map(line).join('\n') || '(no cards)', tasks.map(cardJson))
    return EXIT.ok
  }

  if (sub === 'show') {
    const card = resolveCard(db, selectorFrom(ctx.args))
    const human = [
      `${card.id}  ${card.prUrl}`,
      `stage      ${STAGE_LABEL[card.stage]}`,
      `branch     ${card.branch}`,
      `pr state   ${card.prState}${card.isDraft ? ' (draft)' : ''}`,
      `ci         ${card.ciState ?? 'none'}`,
      `sessions   ${card.sessionIds.length}`,
      `reports    ${card.reviewFiles.length}`,
    ].join('\n')
    ctx.out(human, cardJson(card))
    return EXIT.ok
  }

  if (sub === 'stage') {
    if (!arg) throw new Error(`stage required: one of ${STAGE_NAMES.join(', ')}`)
    return moveStage(db, ctx, readStage(arg))
  }

  if (VERB_STAGE[sub]) return moveStage(db, ctx, VERB_STAGE[sub])

  // What /do-review calls once the comments are on GitHub: says what happened, lets the CLI pick
  // the stage. Acting on a card also means I've seen it, so the unread markers clear.
  if (sub === 'comments-pushed') {
    const count = flagNumber(ctx.args.flags, 'count')
    if (count === undefined) throw new Error('--count <n> required')
    return moveStage(db, ctx, 'reviewed', (id) => {
      if (count > 0) {
        db.setSeen(id, true)
        db.clearNewActivity(id)
      }
    })
  }

  throw new Error(`unknown ${ctx.args.path[0]} command "${sub}"`)
}

const prLine = (p: MyPr): string =>
  `${p.id.padEnd(34)} ${COLUMN_LABEL[p.column].padEnd(15)} ${(p.ciState ?? '—').padEnd(8)} ${p.branch}`

const prJson = (p: MyPr) => ({
  id: p.id,
  repo: p.repo,
  repo_path: p.repoPath,
  branch: p.branch,
  pr_number: p.number,
  pr_url: p.url,
  pr_state: p.state,
  column: p.column,
  column_label: COLUMN_LABEL[p.column],
  human_review: p.humanReview,
  bot_review: p.botReview,
  ci_state: p.ciState,
  is_draft: p.isDraft,
})

// A column move, shared by `mine column` and every sugar verb.
const moveColumn = (db: Db, ctx: Ctx, target: PrColumn): number => {
  const pr = resolveMyPr(db, selectorFrom(ctx.args))
  if (ctx.dryRun) {
    ctx.out(`would move ${pr.id}: ${COLUMN_LABEL[pr.column]} → ${COLUMN_LABEL[target]}`, {
      ...prJson(pr),
      would_move_to: target,
      dry_run: true,
    })
    return EXIT.ok
  }
  const move = db.setColumn(pr.id, target, ctx.args.flags.force === true || ctx.args.flags.force === 'true')
  const human = move.changed
    ? `${pr.id}: ${COLUMN_LABEL[move.from]} → ${COLUMN_LABEL[move.to]}`
    : `${pr.id}: already ${COLUMN_LABEL[move.to]} (no change)`
  ctx.out(human, { ...prJson(pr), column: move.to, column_label: COLUMN_LABEL[move.to], moved: move.changed })
  if (move.changed) notifyApp({ kind: 'cards.changed', ids: [pr.id], source: 'cli' })
  return EXIT.ok
}

const mineCommand = (db: Db, ctx: Ctx): number => {
  const [, sub, arg] = ctx.args.path

  if (!sub || sub === 'list') {
    const asked = flagString(ctx.args.flags, 'column')
    const column = asked === undefined ? undefined : readColumn(asked)
    const prs = db.myPrs({ column, repo: flagString(ctx.args.flags, 'repo') })
    ctx.out(prs.map(prLine).join('\n') || '(no pull requests)', prs.map(prJson))
    return EXIT.ok
  }

  if (sub === 'show') {
    const pr = resolveMyPr(db, selectorFrom(ctx.args))
    const human = [
      `${pr.id}  ${pr.url}`,
      `column     ${COLUMN_LABEL[pr.column]}`,
      `branch     ${pr.branch}`,
      `pr state   ${pr.state}${pr.isDraft ? ' (draft)' : ''}`,
      `ci         ${pr.ciState ?? 'none'}`,
      `review     ${pr.humanReview ?? 'none'}${pr.botReview ? ` (bot: ${pr.botReview})` : ''}`,
    ].join('\n')
    ctx.out(human, prJson(pr))
    return EXIT.ok
  }

  if (sub === 'column') {
    if (!arg) throw new Error(`column required: one of ${COLUMN_NAMES.join(', ')}`)
    return moveColumn(db, ctx, readColumn(arg))
  }

  if (VERB_COLUMN[sub]) return moveColumn(db, ctx, VERB_COLUMN[sub])

  throw new Error(`unknown mine command "${sub}"`)
}

const doctor = (ctx: Ctx): number => {
  const path = resolveDbPath()
  try {
    const db = openDb(path, true)
    const tasks = db.tasks()
    // my_prs only exists from migration 013; an older database is still usable, just without it
    const prs = (() => {
      try {
        return db.myPrs().length
      } catch {
        return null
      }
    })()
    db.close()
    const human = [
      `database  ${path}`,
      `review    ${tasks.length} cards`,
      `mine      ${prs === null ? 'not migrated — start this version of the app once' : `${prs} pull requests`}`,
    ].join('\n')
    ctx.out(human, { db: path, cards: tasks.length, my_prs: prs, ok: true })
    return EXIT.ok
  } catch (e) {
    if (e instanceof NoDatabaseError) {
      ctx.out(`database  ${path}\nstatus    not found — start Lookout once first`, {
        db: path,
        ok: false,
        error: String(e.message),
      })
      return EXIT.noDb
    }
    throw e
  }
}

export const run = (argv: string[], stdout = console.log, stderr = console.error): number => {
  const args = parseArgs(argv)
  const json = args.flags.json === true || args.flags.json === 'true'
  const quiet = args.flags.quiet === true || args.flags.quiet === 'true'
  const ctx: Ctx = {
    args,
    json,
    quiet,
    dryRun: args.flags['dry-run'] === true || args.flags['dry-run'] === 'true',
    out: (human, data) => {
      if (quiet) return
      stdout(json ? JSON.stringify(data, null, 2) : human)
    },
  }

  const [command] = args.path
  if (!command || command === 'help' || args.flags.help) {
    stdout(USAGE)
    return EXIT.ok
  }

  try {
    if (command === 'doctor') return doctor(ctx)
    const isReview = REVIEW_ALIASES.includes(command)
    if (!isReview && command !== 'mine') throw new Error(`unknown command "${command}"`)
    const readOnly = ['list', 'show', undefined].includes(args.path[1]) || ctx.dryRun
    const db = openDb(resolveDbPath(), readOnly)
    try {
      return isReview ? reviewCommand(db, ctx) : mineCommand(db, ctx)
    } finally {
      db.close()
    }
  } catch (e) {
    if (e instanceof NoDatabaseError) {
      if (!quiet) stderr(String(e.message))
      return EXIT.noDb
    }
    if (e instanceof NoMatchError) {
      if (!quiet) stderr(String(e.message))
      return EXIT.noMatch
    }
    if (e instanceof AmbiguousError) {
      if (!quiet) stderr([e.message, ...e.matches.map((m) => `  ${m.id}  ${m.branch}`)].join('\n'))
      return EXIT.ambiguous
    }
    if (!quiet) stderr(e instanceof Error ? e.message : String(e))
    return EXIT.error
  }
}
