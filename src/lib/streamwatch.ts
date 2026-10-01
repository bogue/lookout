// Watching: a card waits on GitHub instead of on me — the author pushes, someone reviews my PR, CI
// goes green, the PR merges — then goes back to Queued and its agent resumes with `resume`. Checked
// against what the sync already stores (alerts, CI, PR state): no polling of its own.

export type Trigger = 'author_pushed' | 'reviewed' | 'ci_green' | 'merged'

export const TRIGGERS: { value: Trigger; label: string; waiting: string }[] = [
  { value: 'author_pushed', label: 'The author pushes', waiting: 'the author to push' },
  { value: 'reviewed', label: 'Someone reviews it', waiting: 'a review' },
  { value: 'ci_green', label: 'CI goes green', waiting: 'CI to go green' },
  { value: 'merged', label: 'It merges', waiting: 'the merge' },
]

export type WaitFor = {
  trigger: Trigger
  ref: string // owner/repo#n — the card or PR it watches
  since: string // the watch began: only what happens after it counts
  resume: string // what the agent is told when it fires
  // ci_green only: CI stored as green when the watch began is the old commit's — wait until it
  // leaves green (armed) before a green counts. Every other trigger starts armed.
  armed: boolean
}

const RESUME: Record<Trigger, string> = {
  author_pushed:
    'The PR author pushed new commits since you last looked. Do the follow-up: check whether the earlier review comments are addressed, then stop for my review.',
  reviewed: 'Someone reviewed this PR. Read the new review comments and address them, then stop for my review.',
  ci_green: 'CI is green now. Carry on with the next step, then stop for my review.',
  merged: 'The PR merged. Wrap up whatever is left, then stop for my review.',
}

export const isTrigger = (v: unknown): v is Trigger => TRIGGERS.some((t) => t.value === v)

export const waitFor = (trigger: Trigger, ref: string, since: string, resume?: string, armed = true): WaitFor => ({
  trigger,
  ref,
  since,
  resume: resume?.trim() || RESUME[trigger],
  armed,
})

// What the sync knows about the watched PR: its alerts (an author push is `addressed`, a review of
// my PR `awaiting_me`), and its CI and state from whichever board holds it.
// `at` is when the event happened (alertAt), not when the sync stored it
export type WatchFacts = {
  alerts: { kind: string; taskId: string; at: string }[]
  pr: { ciState: string | null; state: string } | null
}

// An alert's key is kind:taskId[:eventTs] (alerts.ts); the event time is what a watch compares
// against, so a push from before the watch, stored by a sync after it, doesn't count. The time holds
// colons itself, hence the prefix cut rather than a split.
export const alertAt = (key: string, kind: string, taskId: string, createdAt: string): string => {
  const prefix = `${kind}:${taskId}:`
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : createdAt
}

const ALERT_OF: Partial<Record<Trigger, string>> = { author_pushed: 'addressed', reviewed: 'awaiting_me' }

// fire: it happened. arm: CI left green (a push), so the next green counts — save that, keep waiting.
export const checkTrigger = (w: WaitFor, facts: WatchFacts): 'fire' | 'arm' | 'wait' => {
  const alert = ALERT_OF[w.trigger]
  if (alert) return facts.alerts.some((a) => a.kind === alert && a.taskId === w.ref && a.at > w.since) ? 'fire' : 'wait'
  if (w.trigger === 'ci_green') {
    const ci = facts.pr?.ciState
    if (!ci) return 'wait'
    if (!w.armed) return ci === 'pass' ? 'wait' : 'arm'
    return ci === 'pass' ? 'fire' : 'wait'
  }
  return facts.pr?.state === 'merged' ? 'fire' : 'wait'
}

export const waitingLabel = (w: WaitFor): string => {
  const what = TRIGGERS.find((t) => t.value === w.trigger)?.waiting ?? w.trigger
  return `waiting for ${what} on #${w.ref.split('#')[1] ?? w.ref}`
}

// the stored JSON back to a watch; anything off-shape is no watch
export const parseWaitFor = (json: string | null): WaitFor | null => {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    return v && isTrigger(v.trigger) && typeof v.ref === 'string' && typeof v.since === 'string'
      ? waitFor(v.trigger, v.ref, v.since, typeof v.resume === 'string' ? v.resume : undefined, v.armed !== false)
      : null
  } catch {
    return null
  }
}
