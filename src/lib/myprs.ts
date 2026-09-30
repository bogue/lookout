import type { Alert, Config, MyPr } from '../types'
import { MY_PR_ALERT_KINDS, myPrAlerts } from './alerts'
import { getConfig, setGithubUser } from './config'
import { allMyPrs, dropMyPrsMissingFrom, pruneDoneMyPrs, pruneMyPrRepos, syncAlerts, upsertMyPr } from './db'
import { fetchBotLogins, fetchLogin, fetchPrExchange, type GhMyPr, listMyPrs, type PrExchange } from './gh'
import { logError } from './log'
import { notify } from './notify'
import { isBot, isBoardable, toMyPr } from './prboard'
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

// Bot logins seen so far (see fetchBotLogins). Kept across passes: an account doesn't stop being a bot,
// and a failed lookup must not turn Cursor back into a person — that flips its verdict and wakes cards.
const knownBots = new Set<string>()

const botAware = (author: { login?: string; is_bot?: boolean } | null) =>
  author?.login && knownBots.has(author.login) ? { ...author, is_bot: true } : author

// gh's authors carry no bot flag; set it from knownBots so isBot (prboard.ts) sees what GitHub does
const markBots = (raw: GhMyPr): GhMyPr => ({
  ...raw,
  latestReviews: raw.latestReviews.map((r) => ({ ...r, author: botAware(r.author) as GhMyPr['latestReviews'][number]['author'] })),
})

// Comments + reviews from people other than me. Bots are left out: Cursor re-reviews and CI bots post
// on every push, which would wake a snoozed card on each commit just like CI did.
const humanActivity = (x: PrExchange, me: string): number =>
  [...x.comments, ...x.reviews].filter((c) => c.author?.login !== me && !isBot(botAware(c.author))).length

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
    const open = raw.filter((r) => r.state === 'OPEN').map((r) => r.number)
    for (const b of await fetchBotLogins(repo, open).catch((e) => {
      logError('myprs', e, `bot lookup ${repo}`) // keep the bots already known
      return []
    }))
      knownBots.add(b)
    const seen: string[] = []
    for (const r of raw) {
      const fresh = toMyPr(markBots(r), repo, path)
      if (!isBoardable(fresh, today)) continue // merged/closed before today: not this board's business
      const prev = stored.get(fresh.id)
      seen.push(fresh.id)
      if (fresh.state === 'open') {
        const x = await fetchPrExchange(repo, fresh.number, me).catch((e) => {
          console.error(`my-PR activity fetch failed for ${fresh.id}:`, e)
          logError('myprs', e, `activity ${fresh.id}`)
          return null
        })
        if (x) exchanges.set(fresh.id, x)
        // a failed fetch keeps the stored count: no baseline lost, no wake from a blip
        fresh.activityCount = x ? humanActivity(x, me) : (prev?.activityCount ?? null)
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
    const x = exchanges.get(pr.id) ?? await fetchPrExchange(pr.repo, pr.number, me).catch((e) => {
      console.error(`my-PR alert check failed for ${pr.id}:`, e)
      logError('myprs', e, `alert check ${pr.id}`)
      return null
    })
    if (x) derived.push(...myPrAlerts(pr, x, me))
  }
  const fresh = await syncAlerts({ kinds: MY_PR_ALERT_KINDS, repos }, derived)
  if (fresh.length > 3) {
    await notify(`${fresh.length} of your PRs got reviewed`, 'Open Lookout to see what changed')
    return
  }
  for (const a of fresh) await notify(a.title, a.body, { alertKey: a.key, taskId: a.taskId })
}
