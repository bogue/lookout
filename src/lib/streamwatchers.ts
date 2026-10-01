// Watchers: standing rules that turn what the sync found into Stream cards — my review was
// requested, the author pushed after my review, my PR got a review, my PR's CI is red. A tick reads
// what the sync already stored (tasks, my PRs, alerts): no `gh` call of its own. Created cards land
// in Queued, where the risk check decides whether they may start without me.

export type WatcherCheck = 'review_requested' | 'author_pushed' | 'my_pr_reviewed' | 'my_pr_ci_red'

export const WATCHER_CHECKS: { value: WatcherCheck; label: string }[] = [
  { value: 'review_requested', label: 'My review is requested' },
  { value: 'author_pushed', label: 'The author pushed after my review' },
  { value: 'my_pr_reviewed', label: 'My PR got a review' },
  { value: 'my_pr_ci_red', label: "My PR's CI is red" },
]

export type Watcher = {
  id: string
  name: string
  enabled: boolean
  every: number // minutes between runs, ≥ 1
  repo: string | null // one project, or null for all watched ones
  check: WatcherCheck
  templateId: string | null // the flow its cards follow; null: a one-step card with the default task
}

export const DEFAULT_WATCHERS: Watcher[] = [
  {
    id: 'review-requested',
    name: 'Review requested',
    enabled: false,
    every: 15,
    repo: null,
    check: 'review_requested',
    templateId: 'review-cycle',
  },
  {
    id: 'author-pushed',
    name: 'Follow up when the author pushes',
    enabled: false,
    every: 15,
    repo: null,
    check: 'author_pushed',
    templateId: null,
  },
  {
    id: 'my-pr-reviewed',
    name: 'Handle feedback on my PR',
    enabled: false,
    every: 15,
    repo: null,
    check: 'my_pr_reviewed',
    templateId: 'handle-my-pr-feedback',
  },
  {
    id: 'my-pr-ci-red',
    name: 'Fix my red CI',
    enabled: false,
    every: 30,
    repo: null,
    check: 'my_pr_ci_red',
    templateId: null,
  },
]

// the task a watcher's card gets when it follows no flow
export const DEFAULT_TASK: Record<WatcherCheck, (n: number) => string> = {
  review_requested: (n) => `Review pull request #${n}`,
  author_pushed: (n) => `Follow up on #${n}: the author pushed — check whether the earlier review points are addressed`,
  my_pr_reviewed: (n) => `Address the new review comments on my pull request #${n}`,
  my_pr_ci_red: (n) => `Make CI green on my pull request #${n}: find the failing checks, fix them, commit`,
}

// What a tick reads: the sync's stored PRs and alerts (shapes trimmed to what is used)
export type WatchFacts = {
  tasks: {
    id: string
    repo: string
    prNumber: number
    prTitle: string
    prState: string
    isDraft: boolean
    reviewRequested: boolean
  }[]
  myPrs: { id: string; repo: string; number: number; title: string; state: string }[]
  alerts: { key: string; kind: string; taskId: string }[]
}

// one thing a watcher found: a PR, and the event on it (so the same event never makes two cards)
export type Match = { ref: string; repo: string; number: number; title: string; event: string }

const ALERT_OF: Partial<Record<WatcherCheck, string>> = {
  author_pushed: 'addressed',
  my_pr_reviewed: 'awaiting_me',
  my_pr_ci_red: 'ci_fail',
}

export const matchesOf = (w: Watcher, f: WatchFacts): Match[] => {
  const mine = w.check === 'my_pr_reviewed' || w.check === 'my_pr_ci_red'
  const found: Match[] =
    w.check === 'review_requested'
      ? f.tasks
          .filter((t) => t.reviewRequested && t.prState === 'open' && !t.isDraft)
          .map((t) => ({ ref: t.id, repo: t.repo, number: t.prNumber, title: t.prTitle, event: 'requested' }))
      : f.alerts
          .filter((a) => a.kind === ALERT_OF[w.check])
          .flatMap((a): Match[] => {
            if (mine) {
              const p = f.myPrs.find((x) => x.id === a.taskId && x.state === 'open')
              return p ? [{ ref: p.id, repo: p.repo, number: p.number, title: p.title, event: a.key }] : []
            }
            const t = f.tasks.find((x) => x.id === a.taskId && x.prState === 'open')
            return t ? [{ ref: t.id, repo: t.repo, number: t.prNumber, title: t.prTitle, event: a.key }] : []
          })
  return w.repo ? found.filter((m) => m.repo === w.repo) : found
}

// the card's dedupe key: watcher|PR|event. A live card for the same watcher and PR also holds off a
// new one (see runWatchers), so a PR gets one card at a time, and an event one card ever.
export const watcherKey = (w: Watcher, m: Pick<Match, 'ref' | 'event'>) => `${w.id}|${m.ref}|${m.event}`

// the enabled watchers whose interval passed since they last ran (`last`: watcher id → ISO time)
export const dueWatchers = (ws: Watcher[], last: Record<string, string>, now = Date.now()): Watcher[] =>
  ws.filter((w) => {
    if (!w.enabled) return false
    const at = last[w.id]
    return !at || now - Date.parse(at) >= w.every * 60_000
  })

const isCheck = (v: unknown): v is WatcherCheck => WATCHER_CHECKS.some((c) => c.value === v)

// stored watchers back to watchers (a hand-edited config can't break the board); none = the defaults
export const readWatchers = (v: unknown): Watcher[] => {
  if (!Array.isArray(v)) return DEFAULT_WATCHERS
  return v.flatMap((w): Watcher[] => {
    if (typeof w?.id !== 'string' || typeof w?.name !== 'string' || !isCheck(w.check)) return []
    return [
      {
        id: w.id,
        name: w.name,
        enabled: w.enabled === true,
        every: Math.max(1, Math.round(Number.isFinite(Number(w.every)) ? Number(w.every) : 15)),
        repo: typeof w.repo === 'string' && w.repo ? w.repo : null,
        check: w.check,
        templateId: typeof w.templateId === 'string' && w.templateId ? w.templateId : null,
      },
    ]
  })
}
