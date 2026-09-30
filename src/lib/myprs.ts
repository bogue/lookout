import type { Alert, Config, MyPr } from '../types'
import { MY_PR_ALERT_KINDS, myPrAlerts } from './alerts'
import { getConfig, setGithubUser } from './config'
import {
  allMyPrs,
  dropMyPrsMissingFrom,
  ghLogins,
  pruneDoneMyPrs,
  pruneMyPrRepos,
  saveGhLogins,
  setMyPrSnoozed,
  syncAlerts,
  upsertMyPr,
} from './db'
import { fetchAuthorKinds, fetchLogin, fetchMyPr, fetchPrExchange, type GhMyPr, listMyPrs, type PrExchange } from './gh'
import { logError } from './log'
import { notify } from './notify'
import { isBoardable, isBot, toMyPr } from './prboard'
import { resolveColumn } from './prcolumns'
import { type LegacyPrStore, migrateLegacyPrStore } from './proverrides'
import { startOfToday } from './time'

// What wakes a snoozed card: anything GitHub reports differently about the PR since the last pass —
// a new human comment or review (even one that leaves the verdict as it was), a review verdict (human
// or bot), CI turning red, merge conflicts, merge/close, or the column its reviews point at (a
// re-review request moves that). Other CI moves don't: every push cycles it pending -> pass, which
// would wake a snoozed card on each commit.
const hasNews = (prev: MyPr, fresh: MyPr): boolean =>
  (prev.activityCount !== null && fresh.activityCount !== null && fresh.activityCount > prev.activityCount) ||
  prev.humanReview !== fresh.humanReview ||
  prev.botReview !== fresh.botReview ||
  (fresh.ciState === 'fail' && prev.ciState !== 'fail') ||
  prev.conflicts !== fresh.conflicts ||
  prev.state !== fresh.state ||
  prev.derivedColumn !== fresh.derivedColumn

const EXCHANGE_BATCH = 4 // exchange fetches in flight at once, per repo

// login -> is a bot, for every review/comment author already classified (gh_logins, see fetchAuthorKinds)
type Logins = Map<string, boolean>
type Author = { login?: string; is_bot?: boolean } | null

const botAware = (author: Author, logins: Logins) =>
  author?.login && logins.get(author.login) ? { ...author, is_bot: true } : author

// gh's authors carry no bot flag; set it from gh_logins so isBot (prboard.ts) sees what GitHub does
const markBots = (raw: GhMyPr, logins: Logins): GhMyPr => ({
  ...raw,
  latestReviews: raw.latestReviews.map((r) => ({
    ...r,
    author: botAware(r.author, logins) as GhMyPr['latestReviews'][number]['author'],
  })),
})

// Comments + reviews from people other than me. Bots are left out: Cursor re-reviews and CI bots post
// on every push, which would wake a snoozed card on each commit just like CI did.
const humanActivity = (x: PrExchange, me: string, logins: Logins): number =>
  [...x.comments, ...x.reviews].filter((c) => c.author?.login !== me && !isBot(botAware(c.author, logins))).length

// Ask GraphQL only about authors never classified, and only on the PRs where they appear: once
// gh_logins fills up, most syncs make no call. A login the answer leaves out (past its last 100
// reviews/comments) is stored as a person, so it isn't asked about again. A failed lookup stores
// nothing: those logins read as people this pass and are asked about on the next.
const learnLogins = async (
  repo: string,
  open: GhMyPr[],
  exchanges: Map<string, PrExchange>,
  me: string,
  logins: Logins,
) => {
  const fresh = new Map<number, Set<string>>() // PR number -> logins not classified yet
  for (const r of open) {
    const x = exchanges.get(`${repo}#${r.number}`)
    const authors: Author[] = [...r.latestReviews, ...(x?.reviews ?? []), ...(x?.comments ?? [])].map((a) => a.author)
    for (const a of authors) {
      if (!a?.login || a.login === me || isBot(a) || logins.has(a.login)) continue
      fresh.set(r.number, (fresh.get(r.number) ?? new Set()).add(a.login))
    }
  }
  if (!fresh.size) return
  let kinds: Logins
  try {
    kinds = await fetchAuthorKinds(repo, [...fresh.keys()])
  } catch (e) {
    logError('myprs', e, `bot lookup ${repo}`)
    return
  }
  const learned: Logins = new Map([...fresh.values()].flatMap((s) => [...s]).map((l) => [l, kinds.get(l) ?? false]))
  for (const [l, bot] of learned) logins.set(l, bot)
  await saveGhLogins(learned).catch((e) => logError('myprs', e, 'save gh logins')) // still used this pass
}

// Snoozing takes a fresh baseline for hasNews. What the last sync stored can be 10 min old (a comment
// just read in the panel would wake the card), and the panel's timeline refresh stores verdicts the
// list call doesn't share (it can't see a pending re-review request). Either woke the card on the next
// sync. GitHub unreachable: flip the flag alone, as before.
export const snoozeMyPr = async (pr: MyPr, me: string) => {
  try {
    const [raw, x, logins] = await Promise.all([
      fetchMyPr(pr.repo, pr.number),
      fetchPrExchange(pr.repo, pr.number, me),
      ghLogins(),
    ])
    const fresh = toMyPr(markBots(raw, logins), pr.repo, pr.repoPath)
    await upsertMyPr({
      ...fresh,
      column: resolveColumn(pr.column, pr.derivedColumn, fresh.derivedColumn),
      sortOrder: pr.sortOrder,
      activityCount: humanActivity(x, me, logins), // an unclassified bot only lowers the next count
      snoozed: true,
    })
  } catch (e) {
    logError('myprs', e, `snooze baseline ${pr.id}`)
    await setMyPrSnoozed(pr.id, true)
  }
}

// One pass: list the PRs I authored across watched repos and reconcile them into `my_prs`.
//
// Reconciliation is per repo, not global: a repo whose `gh` call throws keeps every row it already
// has. That is deliberate — the board used to be rebuilt from scratch each pass, so one network blip
// emptied that repo's columns until the next poll ten minutes later.
export const syncMyPrs = async (config?: Config): Promise<MyPr[]> => {
  const cfg = config ?? (await getConfig())
  let me = cfg.githubUser
  if (!me) {
    me = await fetchLogin()
    await setGithubUser(me)
  }

  const today = startOfToday()
  await pruneMyPrRepos(cfg.repos.map((r) => r.repo))
  await pruneDoneMyPrs(today) // drops what aged out of Done since the last pass

  const stored = new Map((await allMyPrs()).map((p) => [p.id, p]))
  // placements and drag positions from the retired pr-overrides.json, carried over once so nobody
  // has to re-drag their board (empty on every later pass — the store is cleared as it's read)
  const legacy: LegacyPrStore = await migrateLegacyPrStore().catch(() => ({ columns: {}, orders: {} }))
  const listed: string[] = [] // repos that answered; a failed one keeps its alerts untouched
  const exchanges = new Map<string, PrExchange>() // fetched once per open PR, shared with the alert pass
  const logins: Logins = await ghLogins().catch((e) => {
    logError('myprs', e, 'load gh logins') // every author gets asked about again; no worse than a first run
    return new Map()
  })
  for (const { repo, path } of cfg.repos) {
    let raw: Awaited<ReturnType<typeof listMyPrs>>
    try {
      raw = await listMyPrs(repo, me)
    } catch (e) {
      console.error(`my-PR sync failed for ${repo}:`, e) // one bad repo shouldn't drop its cards
      logError('myprs', e, `list ${repo}`)
      continue
    }
    listed.push(repo)
    // exchanges first: their authors are what the bot lookup needs before any PR is classified
    const open = raw.filter((r) => r.state === 'OPEN')
    // a few at a time: one serial `gh pr view` per open PR made the sync grow with the PR count
    for (let i = 0; i < open.length; i += EXCHANGE_BATCH) {
      await Promise.all(
        open.slice(i, i + EXCHANGE_BATCH).map(async (r) => {
          const id = `${repo}#${r.number}`
          const x = await fetchPrExchange(repo, r.number, me).catch((e) => {
            console.error(`my-PR activity fetch failed for ${id}:`, e)
            logError('myprs', e, `activity ${id}`)
            return null
          })
          if (x) exchanges.set(id, x)
        }),
      )
    }
    await learnLogins(repo, open, exchanges, me, logins)
    const seen: string[] = []
    for (const r of raw) {
      const fresh = toMyPr(markBots(r, logins), repo, path)
      if (!isBoardable(fresh, today)) continue // merged/closed before today: not this board's business
      const prev = stored.get(fresh.id)
      seen.push(fresh.id)
      if (fresh.state === 'open') {
        const x = exchanges.get(fresh.id)
        // a failed fetch keeps the stored count: no baseline lost, no wake from a blip
        fresh.activityCount = x ? humanActivity(x, me, logins) : (prev?.activityCount ?? null)
      }
      if (prev) {
        // GitHub only gets to move the card when its own verdict changed (see prcolumns.ts)
        fresh.column = resolveColumn(prev.column, prev.derivedColumn, fresh.derivedColumn)
        fresh.sortOrder = prev.sortOrder
        fresh.snoozed = prev.snoozed && !hasNews(prev, fresh)
      } else {
        // never seen before: an old hand-off, if there was one, is where the card starts
        fresh.column = legacy.columns[fresh.id] ?? fresh.column
      }
      fresh.sortOrder ??= legacy.orders[fresh.id] ?? null
      await upsertMyPr(fresh)
    }
    await dropMyPrsMissingFrom(repo, seen)
  }

  const prs = await allMyPrs()
  await refreshMyPrAlerts(prs, listed, me, exchanges)
  return prs
}

// "A human reviewed my PR and I haven't pushed since" needs review timestamps + commits, which the list
// call doesn't carry — so it reads the exchange syncMyPrs already fetched, for open PRs that actually
// hold a human review (and fetches again only where that fetch failed).
// Reconciliation is scoped to the repos we listed successfully, which also clears alerts for PRs that
// merged or dropped out of the list entirely.
const refreshMyPrAlerts = async (prs: MyPr[], repos: string[], me: string, exchanges: Map<string, PrExchange>) => {
  const derived: Alert[] = []
  for (const pr of prs.filter((p) => p.state === 'open' && p.humanReview !== null)) {
    const x =
      exchanges.get(pr.id) ??
      (await fetchPrExchange(pr.repo, pr.number, me).catch((e) => {
        console.error(`my-PR alert check failed for ${pr.id}:`, e)
        logError('myprs', e, `alert check ${pr.id}`)
        return null
      }))
    if (x) derived.push(...myPrAlerts(pr, x, me))
  }
  const fresh = await syncAlerts({ kinds: MY_PR_ALERT_KINDS, repos }, derived)
  if (fresh.length > 3) {
    await notify(`${fresh.length} of your PRs got reviewed`, 'Open Lookout to see what changed')
    return
  }
  for (const a of fresh) await notify(a.title, a.body, { alertKey: a.key, taskId: a.taskId })
}
