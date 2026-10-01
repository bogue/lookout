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
}

const RESUME: Record<Trigger, string> = {
  author_pushed:
    'The PR author pushed new commits since you last looked. Do the follow-up: check whether the earlier review comments are addressed, then stop for my review.',
  reviewed: 'Someone reviewed this PR. Read the new review comments and address them, then stop for my review.',
  ci_green: 'CI is green now. Carry on with the next step, then stop for my review.',
  merged: 'The PR merged. Wrap up whatever is left, then stop for my review.',
}

export const isTrigger = (v: unknown): v is Trigger => TRIGGERS.some((t) => t.value === v)

export const waitFor = (trigger: Trigger, ref: string, since: string, resume?: string): WaitFor => ({
  trigger,
  ref,
  since,
  resume: resume?.trim() || RESUME[trigger],
})

// What the sync knows about the watched PR: its alerts (an author push is `addressed`, a review of
// my PR `awaiting_me`), and its CI and state from whichever board holds it.
export type WatchFacts = {
  alerts: { kind: string; taskId: string; createdAt: string }[]
  pr: { ciState: string | null; state: string } | null
}

const ALERT_OF: Partial<Record<Trigger, string>> = { author_pushed: 'addressed', reviewed: 'awaiting_me' }

export const triggerFired = (w: WaitFor, facts: WatchFacts): boolean => {
  const alert = ALERT_OF[w.trigger]
  if (alert) return facts.alerts.some((a) => a.kind === alert && a.taskId === w.ref && a.createdAt > w.since)
  if (w.trigger === 'ci_green') return facts.pr?.ciState === 'pass'
  return facts.pr?.state === 'merged'
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
      ? waitFor(v.trigger, v.ref, v.since, typeof v.resume === 'string' ? v.resume : undefined)
      : null
  } catch {
    return null
  }
}
