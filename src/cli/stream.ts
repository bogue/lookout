import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { parseDump, STATUS_LABEL } from '../lib/stream'
import type { StreamItem, StreamStatus } from '../types'
import { flagString } from './args'
import type { Db } from './db'
import type { Ctx } from './main'
import { notifyApp } from './notify'
import { resolveDbPath } from './paths'
import { AmbiguousError, gitFromCwd, NoMatchError, repoFromRemote } from './resolve'

// `lookout stream …`: the Stream board from a terminal or from the agent working an item.
//   add   dump work in, as the board's dump box would (split per target, #project tags)
//   list  what's on the board
//   gate  an agent stops on purpose: a result for my review, or a question
//   note  a line in an item's trail

const STATUSES = Object.keys(STATUS_LABEL) as StreamStatus[]

// the watched projects, from the app's own config next to its database (no config: none known)
const watchedRepos = (): string[] => {
  try {
    const config = JSON.parse(readFileSync(join(dirname(resolveDbPath()), 'config.json'), 'utf8'))
    return Array.isArray(config.repos) ? config.repos.map((r: { repo: string }) => r.repo).filter(Boolean) : []
  } catch {
    return []
  }
}

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// --item <id or its first characters>, else the item whose worktree I'm standing in — which is
// where an agent runs `lookout stream gate`
const resolveItem = (db: Db, ctx: Ctx): StreamItem => {
  const items = db.streamItems()
  const asked = flagString(ctx.args.flags, 'item')
  if (asked) {
    const hits = items.filter((x) => x.id === asked || x.id.startsWith(asked))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw new AmbiguousError(hits.map((x) => ({ id: x.id, branch: x.branch ?? '' })))
    throw new NoMatchError(`no Stream item ${asked}`)
  }
  const cwd = real(process.cwd())
  const inside = items
    .filter((x) => x.checkout)
    .map((x) => ({ x, dir: real(x.checkout as string) }))
    .filter(({ dir }) => cwd === dir || cwd.startsWith(dir + sep))
    .sort((a, b) => b.dir.length - a.dir.length)
  if (inside[0]) return inside[0].x
  throw new NoMatchError('no Stream item here — pass --item <id>, or run it inside the item’s worktree')
}

// the text of a command: --stdin, a --summary/--text flag, or the words after the subcommand
const textOf = (ctx: Ctx, flag: string): string => {
  if (ctx.args.flags.stdin) return ctx.stdin().trim()
  const fromFlag = flagString(ctx.args.flags, flag)
  if (fromFlag !== undefined) return fromFlag.trim()
  const file = flagString(ctx.args.flags, 'file')
  if (file) return readFileSync(file, 'utf8').trim()
  return ctx.args.path.slice(2).join(' ').trim()
}

const line = (x: StreamItem) =>
  `${x.id.slice(0, 8)}  ${STATUS_LABEL[x.status].padEnd(11)} ${(x.repo || '?').padEnd(28)} ${x.title}`

const itemJson = (x: StreamItem) => ({
  id: x.id,
  repo: x.repo || null,
  title: x.title,
  status: x.status,
  gate: x.gate,
  ref: x.ref,
  branch: x.branch,
  checkout: x.checkout,
  created_by: x.createdBy,
})

const changed = (ids: string[]) => notifyApp({ kind: 'cards.changed', ids, source: 'cli' })

export const streamCommand = (db: Db, ctx: Ctx): number => {
  const [, sub] = ctx.args.path

  if (!sub || sub === 'list') {
    const asked = flagString(ctx.args.flags, 'status')
    if (asked !== undefined && !STATUSES.includes(asked as StreamStatus))
      throw new Error(`unknown status "${asked}" — expected one of: ${STATUSES.join(', ')}`)
    const items = db.streamItems({
      status: asked as StreamStatus | undefined,
      repo: flagString(ctx.args.flags, 'repo'),
    })
    ctx.out(items.map(line).join('\n') || '(no items)', items.map(itemJson))
    return 0
  }

  if (sub === 'add') {
    const text = textOf(ctx, 'text')
    if (!text) throw new Error('nothing to add — pass the text, or --stdin')
    const repos = watchedRepos()
    const here = repoFromRemote(gitFromCwd().remote() ?? '')
    // the project for lines with no #tag: --repo, else the repo I'm in when Lookout watches it
    const picked = flagString(ctx.args.flags, 'repo') ?? (here && (!repos.length || repos.includes(here)) ? here : null)
    const dump = parseDump(text, repos, picked)
    const queue = ctx.args.flags.queue === true || ctx.args.flags.queue === 'true'
    if (ctx.dryRun) {
      ctx.out(dump.map((d) => `would add: ${d.title}  (${d.repo ?? 'project to place'})`).join('\n'), {
        would_add: dump,
        dry_run: true,
      })
      return 0
    }
    const ids = db.addStreamItems(dump, queue ? 'queued' : 'idea')
    ctx.out(
      ids.map((id, i) => `${id.slice(0, 8)}  ${dump[i].title}`).join('\n'),
      ids.map((id, i) => ({ id, ...dump[i] })),
    )
    changed(ids)
    return 0
  }

  if (sub === 'gate') {
    const kind = flagString(ctx.args.flags, 'kind') ?? 'result'
    if (kind !== 'result' && kind !== 'question') throw new Error('--kind is result or question')
    const item = resolveItem(db, ctx)
    const text = textOf(ctx, 'summary')
    if (!text) throw new Error('a gate needs --summary <text>, --file <path> or --stdin')
    if (ctx.dryRun) {
      ctx.out(`would stop ${item.id.slice(0, 8)} for ${kind}`, { ...itemJson(item), would_gate: kind, dry_run: true })
      return 0
    }
    if (!db.streamGate(item.id, kind, text))
      throw new Error(`${item.id.slice(0, 8)} is ${item.status} — nothing to stop`)
    ctx.out(`${item.id.slice(0, 8)}: waiting for your ${kind === 'question' ? 'answer' : 'review'}`, {
      ...itemJson(item),
      status: kind === 'question' ? 'question' : 'needs_review',
      gate: kind,
    })
    changed([item.id])
    return 0
  }

  if (sub === 'note') {
    const item = resolveItem(db, ctx)
    const text = textOf(ctx, 'text')
    if (!text) throw new Error('a note needs its text')
    if (!ctx.dryRun) db.streamNote(item.id, text)
    ctx.out(`${item.id.slice(0, 8)}: noted`, { ...itemJson(item), note: text, dry_run: ctx.dryRun })
    if (!ctx.dryRun) changed([item.id])
    return 0
  }

  throw new Error(`unknown stream command "${sub}"`)
}
