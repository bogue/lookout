import type { Alert, Config, MyPr } from '../types'
import { MY_PR_ALERT_KINDS, myPrAlerts } from './alerts'
import { getConfig, setGithubUser } from './config'
import { allMyPrs, dropMyPrsMissingFrom, pruneDoneMyPrs, pruneMyPrRepos, syncAlerts, upsertMyPr } from './db'
import { fetchLogin, fetchPrExchange, listMyPrs } from './gh'
import { notify } from './notify'
import { toMyPr } from './prboard'
import { resolveColumn } from './prcolumns'
import { type LegacyPrStore, migrateLegacyPrStore } from './proverrides'
import { startOfToday } from './time'

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

  await pruneMyPrRepos(cfg.repos.map((r) => r.repo))
  await pruneDoneMyPrs(startOfToday()) // Done keeps only what was merged or closed today

  const stored = new Map((await allMyPrs()).map((p) => [p.id, p]))
  // placements and drag positions from the retired pr-overrides.json, carried over once so nobody
  // has to re-drag their board (empty on every later pass — the store is cleared as it's read)
  const legacy: LegacyPrStore = await migrateLegacyPrStore().catch(() => ({ columns: {}, orders: {} }))
  const listed: string[] = [] // repos that answered; a failed one keeps its alerts untouched
  for (const { repo, path } of cfg.repos) {
    let raw: Awaited<ReturnType<typeof listMyPrs>>
    try {
      raw = await listMyPrs(repo, me)
    } catch (e) {
      console.error(`my-PR sync failed for ${repo}:`, e) // one bad repo shouldn't drop its cards
      continue
    }
    listed.push(repo)
    const seen: string[] = []
    for (const r of raw) {
      const fresh = toMyPr(r, repo, path)
      const prev = stored.get(fresh.id)
      seen.push(fresh.id)
      if (prev) {
        // GitHub only gets to move the card when its own verdict changed (see prcolumns.ts)
        fresh.column = resolveColumn(prev.column, prev.derivedColumn, fresh.derivedColumn)
        fresh.sortOrder = prev.sortOrder
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
  await refreshMyPrAlerts(prs, listed, me)
  return prs
}

// "A human reviewed my PR and I haven't pushed since" needs review timestamps + commits, which the list
// call doesn't carry — so fetch the exchange, but only for open PRs that actually hold a human review.
// Reconciliation is scoped to the repos we listed successfully, which also clears alerts for PRs that
// merged or dropped out of the list entirely.
const refreshMyPrAlerts = async (prs: MyPr[], repos: string[], me: string) => {
  const derived: Alert[] = []
  for (const pr of prs.filter((p) => p.state === 'open' && p.humanReview !== null)) {
    const x = await fetchPrExchange(pr.repo, pr.number, me).catch((e) => {
      console.error(`my-PR alert check failed for ${pr.id}:`, e)
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
