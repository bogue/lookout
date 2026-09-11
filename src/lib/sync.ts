import type { Alert, ReviewTask } from '../types'
import { type AlertScope, myLastWordAt, TASK_ALERT_KINDS, taskAlerts } from './alerts'
import { getConfig, setGithubName, setGithubUser } from './config'
import {
  allTasks,
  pruneRepos,
  setActivity,
  setLinks,
  setPrState,
  setSnoozed,
  setStage,
  syncAlerts,
  upsertPr,
} from './db'
import { fetchLogin, fetchName, fetchPrExchange, fetchPrState, listCommentedByMe, listOpenPrs } from './gh'
import { notify } from './notify'
import { scanReviewFiles } from './reviews'
import { approvedByMe, deriveStage } from './reviewstage'
import { scanRepoSessions } from './sessions'
import { BOARD_STAGES } from './stages'

// Stages whose PRs we actively watch for new comments / CI: everything on the board bar Done.
const ACTIVE_STAGES = new Set<string>(BOARD_STAGES.filter((s) => s !== 'done'))

// One full sync pass: poll gh, upsert PRs, link sessions/review files, advance stages, auto-clear merged.
export const syncAll = async (): Promise<ReviewTask[]> => {
  const config = await getConfig()
  let me = config.githubUser
  if (!me) {
    me = await fetchLogin()
    await setGithubUser(me)
  }
  // resolve my display name once (used to attribute commits, whose actor is a git name, not a login)
  if (!config.githubName) {
    const name = await fetchName().catch(() => '')
    if (name) await setGithubName(name)
  }

  // drop tasks for repos no longer watched so removed projects vanish from Discovery/board
  await pruneRepos(config.repos.map((r) => r.repo))

  const known = new Map((await allTasks()).map((t) => [t.id, t]))
  const openIds = new Set<string>()
  const polledRepos = new Set<string>()
  for (const { repo, path } of config.repos) {
    let prs: Awaited<ReturnType<typeof listOpenPrs>>
    let sessionsByBranch: Awaited<ReturnType<typeof scanRepoSessions>>
    let reviewsByBranch: Awaited<ReturnType<typeof scanReviewFiles>>
    let commentedByMe: Set<number>
    try {
      ;[prs, sessionsByBranch, reviewsByBranch, commentedByMe] = await Promise.all([
        listOpenPrs(repo),
        scanRepoSessions(path),
        scanReviewFiles(path),
        listCommentedByMe(repo, me),
      ])
    } catch (e) {
      console.error(`sync failed for ${repo}:`, e)
      continue // don't let one repo break the pass (or falsely auto-clear its tasks)
    }
    polledRepos.add(repo)
    for (const pr of prs) {
      if (pr.author.login === me) continue // never track my own PRs
      const id = `${repo}#${pr.number}`
      openIds.add(id)
      await upsertPr({
        id,
        repo,
        repoPath: path,
        branch: pr.headRefName,
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        prAuthor: pr.author.login,
        prCreatedAt: pr.createdAt,
        reviewRequested: pr.reviewRequests.some((r) => r.login === me),
        isDraft: pr.isDraft,
      })
      const sessionIds = sessionsByBranch.get(pr.headRefName) ?? []
      // /do-review flattens "/" in branch names when building the report filename
      const reviewFiles =
        reviewsByBranch.get(pr.headRefName) ?? reviewsByBranch.get(pr.headRefName.replace(/\//g, '-')) ?? []
      if (sessionIds.length || reviewFiles.length) await setLinks(id, sessionIds, reviewFiles)

      // already reviewed or commented on GitHub -> skip Discovery, board it as Reviewed (the poll
      // below refines that: an approval of mine lands it in Done)
      const engaged = pr.latestReviews.some((r) => r.author.login === me) || commentedByMe.has(pr.number)
      if (engaged && (known.get(id)?.stage ?? 'discovered') === 'discovered') await setStage(id, 'reviewed')
    }
  }

  // Advance stages + auto-clear
  const tasks = await allTasks()
  const derived: Alert[] = [] // alerts recomputed this pass
  for (const t of tasks) {
    // reconcile PR state even for cards already in Done: a card manually moved to Done while its
    // PR was still open would otherwise never pick up a later merge/close (it's skipped below).
    if (polledRepos.has(t.repo) && !openIds.has(t.id) && t.prState === 'open') {
      // tracked PR no longer open: distinguish merged vs closed
      const state = await fetchPrState(t.repo, t.prNumber)
      if (state !== 'open') {
        await setPrState(t.id, state)
        if (t.stage !== 'done') await setStage(t.id, 'done')
        continue
      }
    }
    if (t.stage === 'done') continue // Done is terminal: an approval, a merge, or a manual park

    // watch boarded PRs: refresh the activity/CI badges, re-derive the column from the PR's facts,
    // and re-derive this PR's alerts
    if (ACTIVE_STAGES.has(t.stage) && polledRepos.has(t.repo) && openIds.has(t.id)) {
      try {
        const x = await fetchPrExchange(t.repo, t.prNumber, me)
        const baseline = t.activityCount === null // first fetch: set silently
        const isNew = !baseline && x.count > (t.activityCount ?? 0)
        await setActivity(t.id, x.count, x.ciState, isNew)
        if (x.ciState === 'fail' && t.snoozed) await setSnoozed(t.id, false) // a red build wakes a hidden card
        const stage = deriveStage(t.stage, {
          hasSession: t.sessionIds.length > 0 || t.reviewFiles.length > 0,
          spoke: myLastWordAt(x, me) !== '',
          approvedByMe: approvedByMe(x.reviews, me),
          followupRan: t.followupSummary !== null,
          merged: false, // a merge is reconciled above, off the PR's own state
        })
        if (stage !== t.stage) await setStage(t.id, stage)
        derived.push(...taskAlerts({ ...t, stage }, x, me)) // alerts read the column we just derived
      } catch (e) {
        console.error(`activity poll failed for ${t.id}:`, e)
      }
    }
  }

  // scoped by repo, not by task: a card that just left the polled set (done, merged, ignored) derives
  // nothing this pass, and that's exactly what should drop its alerts
  await publishAlerts({ kinds: TASK_ALERT_KINDS, repos: [...polledRepos] }, derived)
  return allTasks()
}

// Insert what's new, drop what no longer applies, and toast only the freshly-inserted alerts.
// A first fill (fresh install, or the first pass after a long absence) collapses into one toast
// instead of a dozen.
const publishAlerts = async (scope: AlertScope, derived: Alert[]) => {
  const fresh = await syncAlerts(scope, derived)
  if (fresh.length > 3) {
    await notify(`${fresh.length} pull requests need you`, 'Open Lookout to see what changed')
    return
  }
  for (const a of fresh) await notify(a.title, a.body, { alertKey: a.key, taskId: a.taskId })
}

// One PR's alerts, re-derived on demand (e.g. right after a review session finishes) so the bell
// doesn't wait for the next full sync.
export const syncTaskAlerts = async (task: ReviewTask, me: string) => {
  const x = await fetchPrExchange(task.repo, task.prNumber, me).catch(() => null)
  if (x) await publishAlerts({ kinds: TASK_ALERT_KINDS, taskIds: [task.id] }, taskAlerts(task, x, me))
}
