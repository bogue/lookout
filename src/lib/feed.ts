import type { PrState, ReviewFlavor, ReviewTask } from '../types'
import { reviewFileTs } from './alerts'
import { fetchPrTimeline, type GhTimelineEvent } from './gh'
import { logError, logInfo } from './log'
import { isBot, reviewFlavor } from './prboard'
import { sessionsForBranch } from './sessions'

export type FeedEvent = {
  ts: string
  icon: string
  actor: string
  text: string
  mine: boolean // my action -> right side of the chat, others -> left
  url?: string // opens in the PR window
  filePath?: string // opens the local review report
  sessionId?: string // resumes the claude session
}

const REVIEW_ICONS: Record<string, string> = {
  approved: '✅',
  'changes requested': '🔴',
  commented: '📝',
}

const KIND_ICONS = {
  commit: '📦',
  comment: '💬',
  review_requested: '👀',
  merged: '🟣',
  closed: '❌',
  reopened: '♻️',
  force_pushed: '⚠️',
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
      icon: '🌱',
      actor: task.prAuthor,
      text: 'opened the pull request',
      mine: isMine(task.prAuthor),
    })

  if (task.repoPath) {
    const sessions = await sessionsForBranch(task.repoPath, task.branch).catch((e) => {
      logError('feed', e, `sessions for ${task.branch} in ${task.repoPath}`)
      return []
    })
    for (const s of sessions)
      if (s.ts)
        events.push({
          ts: s.ts,
          icon: '🤖',
          actor: 'you',
          text: s.command ? `started /${s.command} session` : 'started a claude session',
          mine: true,
          sessionId: s.sessionId,
        })
  }

  for (const f of task.reviewFiles) {
    const ts = reviewFileTs(f)
    if (ts) events.push({ ts, icon: '📄', actor: 'claude', text: 'review report created', filePath: f, mine: true })
  }

  // an empty timeline here is indistinguishable on screen from a PR with no activity, so say which
  // one it was — the gh error itself is already logged by gh.ts
  const gh = await fetchPrTimeline(task.repo, task.prNumber).catch(() => [])
  for (const e of gh) {
    const mine = isMine(e.actor)
    if (e.kind === 'review')
      events.push({
        ts: e.ts,
        icon: REVIEW_ICONS[e.text] ?? '📝',
        actor: e.actor,
        text: `review: ${e.text}`,
        url: e.url,
        mine,
      })
    else events.push({ ts: e.ts, icon: KIND_ICONS[e.kind], actor: e.actor, text: e.text, url: e.url, mine })
  }

  const asc = events.sort((a, b) => a.ts.localeCompare(b.ts))
  logInfo('feed', `${task.repo}#${task.prNumber}: ${asc.length} events (${gh.length} from the github timeline)`)
  // chronological: newest last, next to the reply input
  return { feed: groupCommits(asc), summary: deriveSummary(gh) }
}
