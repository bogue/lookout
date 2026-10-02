import type { PrState, ReviewFlavor, ReviewTask } from '../types'
import { reviewFileTs } from './alerts'
import { capturedReviewsForTask } from './db'
import { fetchPrTimeline, type GhTimelineEvent } from './gh'
import type { IconName } from './icons'
import { logError, logInfo } from './log'
import { isBot, reviewFlavor } from './prboard'
import { sessionsForBranch } from './sessions'

export type FeedEvent = {
  ts: string
  icon: IconName
  actor: string
  text: string
  mine: boolean // my action -> right side of the chat, others -> left
  // a GitHub login shows that account's picture; an emoji stands in for what has none (👀 Lookout).
  // A session I spawned is mine, shown as me; a saved report is Lookout's
  // url: the picture GitHub sent, when it did. badge: a small picture over the corner — Lookout (👀)
  // wears mine, since it acts for me
  avatar: { login: string; url?: string } | { emoji: string; badge?: string }
  url?: string // opens in the PR window
  filePath?: string // opens the local review report
  body?: string // a captured review's markdown — stored, with no file behind it (capture.ts)
  sessionId?: string // resumes the claude session
  fromSession?: string // a captured report: the session it was read out of
  // the session a report answers, quoted over it like a chat reply. exact = the capture named it;
  // a report file names none, so it quotes the last session started before it (a guess)
  replyTo?: { icon: IconName; text: string; ts: string; exact: boolean }
}

// Tie each report to the session that produced it. Runs on the sorted feed.
export const linkReports = (events: FeedEvent[]): FeedEvent[] => {
  const sessions = events.filter((e) => e.sessionId)
  return events.map((e) => {
    if (!(e.filePath || e.body)) return e
    const quote = (s: FeedEvent | undefined, exact: boolean) =>
      s ? { ...e, replyTo: { icon: s.icon, text: s.text, ts: s.ts, exact } } : e
    if (e.fromSession)
      return quote(
        sessions.find((s) => s.sessionId === e.fromSession),
        true,
      )
    return quote(sessions.filter((s) => s.ts <= e.ts).at(-1), false)
  })
}

// a timeline event with no user behind it is Lookout's own doing, not an anonymous GitHub user
const ghAvatar = (actor: string, url?: string): FeedEvent['avatar'] =>
  actor ? { login: actor, ...(url ? { url } : {}) } : { emoji: '👀' }
// what Lookout did itself, like saving a report onto the card: it acts for me, so on my side, its
// 👀 wearing my picture as a badge
const lookout = (me: string) => ({ actor: 'Lookout', mine: true, avatar: { emoji: '👀', badge: me } })

const REVIEW_ICONS: Record<string, IconName> = {
  approved: 'check-circle-fill',
  'changes requested': 'file-diff',
  commented: 'code-review',
}

const KIND_ICONS: Record<Exclude<GhTimelineEvent['kind'], 'review'>, IconName> = {
  commit: 'git-commit',
  comment: 'chat',
  review_requested: 'eye',
  merged: 'git-merge',
  closed: 'git-pull-request-closed',
  reopened: 'issue-reopened',
  force_pushed: 'repo-push',
}

// Merge consecutive commits by the same actor into one "pushed N commits" event
const groupCommits = (events: FeedEvent[]): FeedEvent[] => {
  const out: FeedEvent[] = []
  for (const e of events) {
    const prev = out.at(-1)
    if (e.icon === KIND_ICONS.commit && prev?.icon === KIND_ICONS.commit && prev.actor === e.actor) {
      const count = (prev.text.match(/^pushed (\d+) commits/)?.[1] ?? '1') as string
      prev.text = `pushed ${Number(count) + 1} commits — ${e.text.replace(/^pushed \d+ commits — /, '')}`
      prev.ts = e.ts
      continue
    }
    out.push({ ...e })
  }
  return out
}

// Card summary reconstructed from the PR timeline already fetched for the feed — lets a card refresh its
// own review verdict / state on open without a second network call. CI + draft aren't in the timeline, so
// they're intentionally absent here (they stay as the last full sync left them).
export type TimelineSummary = {
  prState: PrState | null // from merged/closed/reopened events; null = no state event seen
  humanReview: ReviewFlavor
  botReview: ReviewFlavor
}

// GhTimelineEvent stringifies review verdicts ("changes requested"); map back to what reviewFlavor expects
const REVIEW_STATE: Record<string, string> = {
  approved: 'APPROVED',
  'changes requested': 'CHANGES_REQUESTED',
  commented: 'COMMENTED',
}

// Latest review per actor wins (events are chronological). NOTE: unlike the full sync this can't see a
// pending re-review request, so a superseded verdict can linger on the card until the next sync.
const deriveSummary = (events: GhTimelineEvent[]): TimelineSummary => {
  const latest = new Map<string, string>() // actor login -> latest review state
  let prState: PrState | null = null
  for (const e of events) {
    if (e.kind === 'review') {
      const state = REVIEW_STATE[e.text]
      if (state) latest.set(e.actor, state)
    } else if (e.kind === 'merged') prState = 'merged'
    // a merge also emits a 'closed' event right after; merged wins, so don't let it downgrade the state
    else if (e.kind === 'closed') prState = prState === 'merged' ? 'merged' : 'closed'
    else if (e.kind === 'reopened') prState = 'open'
  }
  const reviews = [...latest].map(([login, state]) => ({ author: { login }, state }))
  return {
    prState,
    humanReview: reviewFlavor(reviews.filter((r) => !isBot(r.author))),
    botReview: reviewFlavor(reviews.filter((r) => isBot(r.author))),
  }
}

// The reports Lookout keeps itself: report files linked to the card, and reviews it captured for the
// flows that export none. A branch that does export one never has its reviews captured (sync.ts),
// so a card cannot show the same review twice. Local reads only — cheap enough to redo whenever the
// card changes, which is how an open panel picks up a report without refetching the timeline.
export const reportEvents = async (task: ReviewTask, me: string): Promise<FeedEvent[]> => {
  const events: FeedEvent[] = []
  for (const f of task.reviewFiles) {
    const ts = reviewFileTs(f)
    if (ts)
      events.push({
        ts,
        icon: 'file',
        ...lookout(me),
        text: 'Review done',
        filePath: f,
      })
  }
  const captured = await capturedReviewsForTask(task.id).catch((e) => {
    logError('feed', e, `captured reviews for ${task.id}`)
    return []
  })
  for (const c of captured)
    events.push({
      ts: c.createdAt,
      icon: c.kind === 'followup' ? 'checklist' : 'file', // a follow-up is a checklist of addressed comments
      ...lookout(me),
      text: c.kind === 'followup' ? 'Follow-up done' : 'Review done',
      body: c.body ?? undefined,
      fromSession: c.sessionId ?? undefined,
      filePath: c.filePath ?? undefined,
    })
  return events
}

const isReport = (e: FeedEvent) => e.actor === 'Lookout' && !!(e.filePath || e.body)

// Swap a built feed's reports for a fresh read of them: what's stored now is the whole truth, so a
// report is added, kept or dropped as the store says, and re-quoted against the feed's sessions.
export const mergeReports = (feed: FeedEvent[], reports: FeedEvent[]): FeedEvent[] =>
  linkReports([...feed.filter((e) => !isReport(e)), ...reports].sort((a, b) => a.ts.localeCompare(b.ts)))

export const buildFeed = async (
  task: ReviewTask,
  me: string,
  myName = '',
): Promise<{ feed: FeedEvent[]; summary: TimelineSummary }> => {
  const events: FeedEvent[] = []
  // timeline actors are logins for most events but git author *names* for commits, so match either
  const isMine = (actor: string) => actor === me || (!!myName && actor === myName)

  if (task.prCreatedAt)
    events.push({
      ts: task.prCreatedAt,
      icon: 'git-pull-request',
      actor: task.prAuthor,
      text: 'opened the pull request',
      mine: isMine(task.prAuthor),
      avatar: ghAvatar(task.prAuthor),
    })

  if (task.repoPath) {
    const sessions = await sessionsForBranch(task.repoPath, task.branch, task.prNumber).catch((e) => {
      logError('feed', e, `sessions for ${task.branch} in ${task.repoPath}`)
      return []
    })
    for (const s of sessions)
      if (s.ts)
        events.push({
          ts: s.ts,
          icon: s.question !== undefined ? 'comment-discussion' : 'dependabot',
          actor: 'you',
          text:
            s.question !== undefined
              ? `chat: ${s.question}`
              : s.command
                ? `started /${s.command} session`
                : 'started a claude session',
          mine: true,
          avatar: { login: me },
          sessionId: s.sessionId,
        })
  }

  events.push(...(await reportEvents(task, me)))

  // an empty timeline here is indistinguishable on screen from a PR with no activity, so say which
  // one it was — the gh error itself is already logged by gh.ts
  const gh = await fetchPrTimeline(task.repo, task.prNumber).catch(() => [])
  for (const e of gh) {
    const mine = isMine(e.actor)
    if (e.kind === 'review')
      events.push({
        ts: e.ts,
        icon: REVIEW_ICONS[e.text] ?? 'code-review',
        actor: e.actor,
        text: `review: ${e.text}`,
        url: e.url,
        mine,
        avatar: ghAvatar(e.actor, e.avatar),
      })
    else
      events.push({
        ts: e.ts,
        icon: KIND_ICONS[e.kind],
        actor: e.actor,
        text: e.text,
        url: e.url,
        mine,
        // a commit's actor is a git author name, not a login: GitHub's picture when the PR commit list
        // had one, else mine is known and anyone else falls back to an initial
        avatar: e.kind === 'commit' && mine && !e.avatar ? { login: me } : ghAvatar(e.actor, e.avatar),
      })
  }

  const asc = events.sort((a, b) => a.ts.localeCompare(b.ts))
  logInfo('feed', `${task.repo}#${task.prNumber}: ${asc.length} events (${gh.length} from the github timeline)`)
  // chronological: newest last, next to the reply input
  return { feed: linkReports(groupCommits(asc)), summary: deriveSummary(gh) }
}
