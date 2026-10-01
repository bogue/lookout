import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { PR_COLUMNS } from '../lib/prboard'
import { parseStage, STAGE_LABEL, STAGES } from '../lib/stages'
import { captureKindOf } from '../lib/transcript'
import type { MyPr, PrColumn, ReviewTask, Stage } from '../types'
import { type Args, flagNumber, flagString, parseArgs } from './args'
import { reviewFromTranscript, transcriptCommand } from './capture'
import { type Db, NoDatabaseError, openDb } from './db'
import { notifyApp } from './notify'
import { resolveDbPath } from './paths'
import { AmbiguousError, NoMatchError, resolveCard, resolveMyPr, type Selector } from './resolve'
import { streamCommand } from './stream'

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
  lookout review report [selector] --file <path> | --stdin [--kind review | followup]
  lookout review capture [selector] --transcript <path> | --hook [--kind review | followup]
  lookout review capture --clear [--older-than <days>]

your own PRs — the merge pipeline

  lookout mine list [--column <c>] [--repo <r>]
  lookout mine show [selector]
  lookout mine column <${COLUMN_NAMES.join(' | ')}> [selector] [--force]
  lookout mine waiting | in-review | ready | done [selector]

the Stream board — work dumped for Lookout's agents

  lookout stream list [--status <s>] [--repo <r>]
  lookout stream add <text…> | --stdin [--repo <owner/repo>] [--queue]
  lookout stream gate [--item <id>] [--kind result | question] --summary <text> | --file <path> | --stdin
  lookout stream note [--item <id>] <text…>

           --item defaults to the item whose worktree you are in

  lookout doctor

selector   --id <id> | --pr <n> | --branch <b> [--repo <owner/repo>]
           defaults to the PR for the current repo + branch
options    --json   machine-readable output
           --quiet  print nothing (exit code only)
           --dry-run  resolve and report, write nothing
           --force  move backwards down a pipeline (both default to forward-only)

\`lookout card …\` is the old name for \`lookout review …\` and still works.
`

export type Ctx = {
  args: Args
  json: boolean
  quiet: boolean
  dryRun: boolean
  out: (human: string, data: unknown) => void
  stdin: () => string // a piped review body, or a hook's JSON payload
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

  // Register a review a skill produced itself: a report file it wrote wherever it likes, or the text
  // on stdin. Either way the card shows it — no AI_TASKS/code-review convention to follow.
  if (sub === 'report') {
    const file = flagString(ctx.args.flags, 'file')
    const piped = isFlag(ctx.args.flags, 'stdin')
    if (!file && !piped) throw new Error('--file <path> or --stdin required')
    const body = piped ? ctx.stdin().trim() : null
    if (piped && !body) throw new Error('nothing on stdin')
    const card = resolveCard(db, selectorFrom(ctx.args))
    const path = file ? resolvePath(file) : null
    const id = path ? `file:${path}` : `cli:${card.id}`
    if (!ctx.dryRun)
      db.saveCapturedReview({
        id,
        kind: readKind(ctx.args.flags),
        taskId: card.id,
        branch: card.branch,
        source: 'cli',
        sessionId: null,
        filePath: path,
        body,
        createdAt: new Date().toISOString(),
      })
    ctx.out(`${ctx.dryRun ? 'would store' : 'stored'} a review for ${card.id}`, { id: card.id, review: id })
    return EXIT.ok
  }

  // Read a review back out of a session transcript — what the Stop hook calls, so a flow that
  // exports nothing still lands its review on the card.
  if (sub === 'capture') {
    if (isFlag(ctx.args.flags, 'clear')) {
      const days = flagNumber(ctx.args.flags, 'older-than')
      const before = days === undefined ? null : new Date(Date.now() - days * 86400_000).toISOString()
      const removed = ctx.dryRun ? 0 : db.clearCapturedReviews(before)
      ctx.out(`cleared ${removed} captured review${removed === 1 ? '' : 's'}`, { removed })
      return EXIT.ok
    }

    const hook = isFlag(ctx.args.flags, 'hook')
    const payload = hook ? hookPayload(ctx.stdin()) : {}
    const transcript = payload.transcript_path ?? flagString(ctx.args.flags, 'transcript')
    if (!transcript) throw new Error('--transcript <path> or --hook required')

    // Resolve the card first: a Stop hook fires on every turn of every session on the machine, and
    // most of them have no card at all. No point reading a quarter of a megabyte to find that out.
    const card = resolveCard(db, selectorFrom(ctx.args))
    const sessionId = payload.session_id ?? flagString(ctx.args.flags, 'session') ?? sessionIdFromPath(transcript)
    const id = sessionId ?? `capture:${card.id}`

    // A hook has no idea what it fired in. Anything that isn't a review run — a debugging session in
    // a worktree that happens to match a card — has nothing to do with this card's review.
    const command = transcriptCommand(transcript)
    const kind = flagString(ctx.args.flags, 'kind') ? readKind(ctx.args.flags) : captureKindOf(command)
    if (hook && !kind) {
      ctx.out('not a review session', { captured: false, reason: 'not-a-review' })
      return EXIT.ok
    }

    // The same rule the app applies: a card whose reviews are exported as files is left alone, and
    // anything captured before that was apparent goes.
    if (card.reviewFiles.length) {
      if (!ctx.dryRun) db.deleteCapturedReview(id)
      ctx.out('the branch exports its own reports', { captured: false, reason: 'exported' })
      return EXIT.ok
    }

    const result = reviewFromTranscript(transcript)
    if (result.kind !== 'captured') {
      if (result.kind === 'exported' && !ctx.dryRun) db.deleteCapturedReview(id)
      ctx.out(`nothing to capture (${result.kind})`, { captured: false, reason: result.kind })
      return EXIT.ok
    }
    if (!ctx.dryRun)
      db.saveCapturedReview({
        id,
        kind: kind ?? 'review',
        taskId: card.id,
        branch: card.branch,
        source: hook ? 'hook' : 'cli',
        sessionId,
        filePath: null,
        body: result.body,
        createdAt: result.ts ?? new Date().toISOString(),
      })
    ctx.out(`${ctx.dryRun ? 'would capture' : 'captured'} a review for ${card.id}`, { id: card.id, captured: true })
    return EXIT.ok
  }

  throw new Error(`unknown ${ctx.args.path[0]} command "${sub}"`)
}

const isFlag = (flags: Args['flags'], name: string) => flags[name] === true || flags[name] === 'true'

// What the session was doing, for the label the card shows. A caller that doesn't say means a review.
const readKind = (flags: Args['flags']): 'review' | 'followup' => {
  const kind = flagString(flags, 'kind') ?? 'review'
  if (kind !== 'review' && kind !== 'followup') throw new Error('--kind expects review or followup')
  return kind
}

// ~/.claude/projects/<slug>/<session id>.jsonl — the same id the app stores a sync capture under, so
// the hook and the app refresh one row instead of racing to write two.
const sessionIdFromPath = (transcript: string): string | null =>
  transcript
    .split('/')
    .at(-1)
    ?.replace(/\.jsonl$/, '') || null

// What a Stop / SessionEnd hook writes on stdin (verified against the shipped ralph-loop stop hook:
// `.session_id` and `.transcript_path`). Anything unexpected reads as an empty payload.
const hookPayload = (raw: string): { session_id?: string; transcript_path?: string } => {
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
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

export const run = (
  argv: string[],
  stdout = console.log,
  stderr = console.error,
  readStdin = () => readFileSync(0, 'utf8'),
): number => {
  const args = parseArgs(argv)
  const json = args.flags.json === true || args.flags.json === 'true'
  // A Stop hook fires in every session, including ones in a repo Lookout has never heard of: it must
  // say nothing and exit 0 whatever it finds, or it turns into noise in someone else's terminal.
  const hookMode = args.flags.hook === true || args.flags.hook === 'true'
  const quiet = hookMode || args.flags.quiet === true || args.flags.quiet === 'true'
  const ctx: Ctx = {
    args,
    json,
    quiet,
    dryRun: args.flags['dry-run'] === true || args.flags['dry-run'] === 'true',
    out: (human, data) => {
      if (quiet) return
      stdout(json ? JSON.stringify(data, null, 2) : human)
    },
    stdin: readStdin,
  }

  const [command] = args.path
  if (!command || command === 'help' || args.flags.help) {
    stdout(USAGE)
    return EXIT.ok
  }

  try {
    if (command === 'doctor') return doctor(ctx)
    const isReview = REVIEW_ALIASES.includes(command)
    if (!isReview && command !== 'mine' && command !== 'stream') throw new Error(`unknown command "${command}"`)
    const readOnly = ['list', 'show', undefined].includes(args.path[1]) || ctx.dryRun
    const db = openDb(resolveDbPath(), readOnly)
    try {
      if (command === 'stream') return streamCommand(db, ctx)
      return isReview ? reviewCommand(db, ctx) : mineCommand(db, ctx)
    } finally {
      db.close()
    }
  } catch (e) {
    if (hookMode) return EXIT.ok // never fail a session's exit over a review we could not place
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
