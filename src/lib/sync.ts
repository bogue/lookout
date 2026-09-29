import type { Alert, ReviewTask } from '../types'
import { type AlertScope, myLastWordAt, TASK_ALERT_KINDS, taskAlerts } from './alerts'
import { captureFromTranscript, captureIfGrown } from './capture'
import { classifySession } from './classify'
import { getConfig, setGithubName, setGithubUser } from './config'
import {
  allTasks,
  capturedCliTaskIds,
  deleteCapturedReview,
  pruneCapturedReviews,
  pruneRepos,
  setActivity,
  setApproved,
  setLinks,
  setPrState,
  setSnoozed,
  setStage,
  syncAlerts,
  upsertCapturedReview,
  upsertPr,
} from './db'
import { fetchLogin, fetchName, fetchPrExchange, fetchPrState, listCommentedByMe, listOpenPrs } from './gh'
import { logError } from './log'
import { notify } from './notify'
import { hasApproval } from './prboard'
import { scanReviewFiles } from './reviews'
import { approvedByMe, deriveStage } from './reviewstage'
import { captureKind, scanRepoReviewSessions, scanRepoSessions, transcriptPath } from './sessions'
import { BOARD_STAGES } from './stages'
import type { CaptureKind, CaptureResult } from './transcript'

// Stages whose PRs we actively watch for new comments / CI: everything on the board bar Done.
const ACTIVE_STAGES = new Set<string>(BOARD_STAGES.filter((s) => s !== 'done'))

const CAPTURE_DAYS = 30 // a month of history, then the row goes

type CaptureTarget = { sessionId: string; kind: CaptureKind; taskId: string; branch: string }

// The branch exports its own reports after all — including when the session in flight wrote one
// since the last pass. Whatever was captured before that was visible has to go, or the card shows
// the guess next to the report for the next 30 days. Those files are reviews (/do-review writes
// them, /do-followup doesn't), so they only ever stand in for a review, never for a follow-up.
const storeCapture = async (t: CaptureTarget, hasReportFiles: boolean, read: () => Promise<CaptureResult | null>) => {
  if (hasReportFiles && t.kind === 'review') return deleteCapturedReview(t.sessionId)
  const result = await read()
  if (result?.kind === 'exported') return deleteCapturedReview(t.sessionId)
  if (result?.kind !== 'captured') return
  await upsertCapturedReview({
    id: t.sessionId,
    kind: t.kind,
    taskId: t.taskId,
    branch: t.branch,
    source: 'sync',
    sessionId: t.sessionId,
    filePath: null,
    body: result.body,
    createdAt: result.ts ?? new Date().toISOString(),
  })
}

// A button run whose turn just finished: capture it now instead of on the next pass. `kind` comes
// from the prompt's slash command; a prompt that names none (null) is classified by Haiku from the
// answer itself, which is what lets a plain-prompt button land on the card at all.
export const captureRun = async (
  r: Omit<CaptureTarget, 'kind'> & { kind: CaptureKind | null; repoPath: string; cwd: string },
): Promise<void> => {
  if (!(await getConfig()).captureReviews) return
  if ((await capturedCliTaskIds()).has(r.taskId)) return // a skill handed this card a review itself
  const files = await scanReviewFiles(r.repoPath)
  const hasReportFiles = (files.get(r.branch) ?? files.get(r.branch.replace(/\//g, '-')) ?? []).length > 0
  if (hasReportFiles && r.kind === 'review') return deleteCapturedReview(r.sessionId) // skip the read
  const result = await captureFromTranscript(await transcriptPath(r.cwd, r.sessionId))
  const kind = r.kind ?? (result.kind === 'captured' ? await classifySession(r.sessionId, result.body) : null)
  if (kind) await storeCapture({ ...r, kind }, hasReportFiles, async () => result)
}

// Reviews a session printed but never exported. A review is skipped for a branch that already has a
// report file: that flow works, and capturing it again would put the same review on the card twice —
// the point is to patch the broken flow only. Display only, so nothing here touches a stage or an alert.
const captureReviews = async (
  repo: string,
  repoPath: string,
  prByBranch: Map<string, number>,
  branchByPr: Map<number, string>,
  filesByBranch: Map<string, string[]>,
) => {
  const registered = await capturedCliTaskIds()
  for (const s of await scanRepoReviewSessions(repoPath)) {
    const kind = captureKind(s)
    if (!kind) continue
    // the session names either the branch it ran on or the PR it was asked to review; a PR id is
    // resolved to the card's own branch, never to whatever checkout the run happened to sit in
    const branch = s.branch ?? (s.prNumber === null ? null : (branchByPr.get(s.prNumber) ?? null))
    if (!branch) continue
    const prNumber = prByBranch.get(branch)
    if (prNumber === undefined) continue // a session on a branch with no PR on the board
    const taskId = `${repo}#${prNumber}`
    if (registered.has(taskId)) continue // a skill handed this card a review itself
    const hasReportFiles = (filesByBranch.get(branch) ?? filesByBranch.get(branch.replace(/\//g, '-')) ?? []).length > 0
    await storeCapture({ sessionId: s.sessionId, kind, taskId, branch }, hasReportFiles, () => captureIfGrown(s.path))
  }
}

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
  // Guarded like every other local step, and for the same reason the comments below give: this runs
  // before a single PR is upserted, so an unguarded throw here (a locked database, a table an older
  // build never migrated) would stop the board updating at all, every pass, for a retention sweep.
  if (config.captureReviews)
    await pruneCapturedReviews(new Date(Date.now() - CAPTURE_DAYS * 86400_000).toISOString()).catch((e) =>
      logError('sync', e, 'prune captured reviews'),
    )

  const known = new Map((await allTasks()).map((t) => [t.id, t]))
  const openIds = new Set<string>()
  const polledRepos = new Set<string>()
  for (const { repo, path } of config.repos) {
    let prs: Awaited<ReturnType<typeof listOpenPrs>>
    let commentedByMe: Set<number>
    try {
      ;[prs, commentedByMe] = await Promise.all([listOpenPrs(repo), listCommentedByMe(repo, me)])
    } catch (e) {
      console.error(`sync failed for ${repo}:`, e)
      logError('sync', e, `repo ${repo}`)
      continue // don't let one repo break the pass (or falsely auto-clear its tasks)
    }
    // The local scans only decorate the cards (linked sessions, review reports), so they are asked
    // for after the PR list and can't cost the repo its PRs: a failing scan sat in the same
    // Promise.all, rejecting it and skipping the upsert loop below, so a single unreadable checkout
    // meant every PR opened from then on never reached the board.
    const [sessionsByBranch, reviewsByBranch] = await Promise.all([
      scanRepoSessions(path).catch((e) => {
        logError('sync', e, `session scan ${repo}`)
        return new Map<string, string[]>()
      }),
      scanReviewFiles(path).catch((e) => {
        logError('sync', e, `review scan ${repo}`)
        return new Map<string, string[]>()
      }),
    ])
    polledRepos.add(repo)
    const boardedPrs = new Map<string, number>() // branch -> PR number, for the capture pass below
    const boardedBranches = new Map<number, string>() // …and back, for a session that named a PR id
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
        approved: hasApproval(pr.latestReviews),
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
      boardedPrs.set(pr.headRefName, pr.number)
      boardedBranches.set(pr.number, pr.headRefName)
    }
    if (config.captureReviews)
      await captureReviews(repo, path, boardedPrs, boardedBranches, reviewsByBranch).catch((e) => {
        logError('sync', e, `review capture ${repo}`) // costs captures only, never the repo's PRs
      })
  }

  // Advance stages + auto-clear
  const tasks = await allTasks()
  const derived: Alert[] = [] // alerts recomputed this pass
  for (const t of tasks) {
    // reconcile PR state even for cards already in Done: a card manually moved to Done while its
    // PR was still open would otherwise never pick up a later merge/close (it's skipped below).
    if (polledRepos.has(t.repo) && !openIds.has(t.id) && t.prState === 'open') {
      // tracked PR no longer open: distinguish merged vs closed
      const { state, approved } = await fetchPrState(t.repo, t.prNumber)
      if (state !== 'open') {
        await setPrState(t.id, state)
        if (approved !== t.approved) await setApproved(t.id, approved)
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
        await setActivity(t.id, x.count, x.ciState, isNew, x.ciChecks, x.conflicts)
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
        logError('sync', e, `activity poll ${t.id}`)
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
