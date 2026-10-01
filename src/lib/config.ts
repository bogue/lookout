import { load, type Store } from '@tauri-apps/plugin-store'
import type { ActionButton, Config, MergePreference, Stage, WatchedRepo } from '../types'
import { LEGACY_STAGE_IDS } from './stages'

// Default buttons reproduce the old fixed actions. /review ships with Claude Code; the follow-up
// default is a plain prompt. Placeholders: <branch_name>, <pr_id>. Users edit/add/remove these.
export const DEFAULT_REVIEW_BUTTONS: ActionButton[] = [
  {
    id: 'do-review',
    label: 'do-review',
    icon: 'play',
    prompt: '/review <pr_id>',
    conditions: [],
    advanceTo: 'reviewing', // a finished session is "Needs Review" — Reviewed means sent on GitHub
    saveReport: 'review',
  },
  {
    id: 'do-followup',
    label: 'do-followup',
    icon: 'refresh',
    prompt:
      'Fetch the review comments of PR #<pr_id> (branch <branch_name>) with gh, check the PR commits to verify whether each comment was addressed, and finish with a line: SUMMARY: X addressed | Y partial | Z pending',
    conditions: [],
    advanceTo: 'followup',
    saveReport: 'followup', // a plain prompt: without this only Haiku could tell what the run was
  },
]

export const DEFAULT_PR_BUTTONS: ActionButton[] = [
  { id: 'handle-review', label: 'handle review', icon: 'git-pull-request', prompt: '/handle-review', conditions: [] },
]

// A saved button can reference a stage id that has since been renamed (migration 012 renamed
// `inbox` to `needs_review`). The database migration can't reach the config store, so translate on
// read: an untouched button keeps matching the column it was set up for.
export const migrateButtons = (buttons: ActionButton[]): ActionButton[] =>
  buttons.map((b) => ({
    ...b,
    advanceTo: b.advanceTo ? (LEGACY_STAGE_IDS[b.advanceTo] ?? b.advanceTo) : b.advanceTo,
    conditions: b.conditions.map((c) =>
      c.field === 'stage' ? { ...c, values: c.values.map((v) => LEGACY_STAGE_IDS[v] ?? (v as Stage)) } : c,
    ),
  }))

let store: Store | null = null

const getStore = async () => {
  if (!store) store = await load('config.json')
  return store
}

export const getConfig = async (): Promise<Config> => {
  const s = await getStore()
  return {
    githubUser: (await s.get<string>('githubUser')) ?? '',
    githubName: (await s.get<string>('githubName')) ?? '',
    repos: (await s.get<WatchedRepo[]>('repos')) ?? [],
    reviewButtons: migrateButtons((await s.get<ActionButton[]>('reviewButtons')) ?? DEFAULT_REVIEW_BUTTONS),
    prButtons: migrateButtons((await s.get<ActionButton[]>('prButtons')) ?? DEFAULT_PR_BUTTONS),
    animations: (await s.get<boolean>('animations')) ?? true,
    // on by default: the failures worth catching (a gh call, a claude spawn) are intermittent, so a
    // switch you have to flip first would never be on when one happens. Rotated at 2 MB.
    logging: (await s.get<boolean>('logging')) ?? true,
    // on by default: this exists for people who never knew a review could be missing from a card, so
    // a switch they have to find first would leave the flow broken for exactly them.
    captureReviews: (await s.get<boolean>('captureReviews')) ?? true,
    openInBrowser: (await s.get<boolean>('openInBrowser')) ?? false,
    notifications: (await s.get<boolean>('notifications')) ?? true,
    mergeMethod: (await s.get<MergePreference>('mergeMethod')) ?? 'merge',
    // on by default: the board is for work agents pick up; a card still waits for me before anything leaves
    streamAutoRun: (await s.get<boolean>('streamAutoRun')) ?? true,
  }
}

export const setStreamAutoRun = async (streamAutoRun: boolean) => {
  const s = await getStore()
  await s.set('streamAutoRun', streamAutoRun)
}

export const setOpenInBrowser = async (openInBrowser: boolean) => {
  const s = await getStore()
  await s.set('openInBrowser', openInBrowser)
}

export const setMergeMethod = async (mergeMethod: MergePreference) => {
  const s = await getStore()
  await s.set('mergeMethod', mergeMethod)
}

export const setNotifications = async (notifications: boolean) => {
  const s = await getStore()
  await s.set('notifications', notifications)
}

export const setCaptureReviews = async (captureReviews: boolean) => {
  const s = await getStore()
  await s.set('captureReviews', captureReviews)
}

export const setLogging = async (logging: boolean) => {
  const s = await getStore()
  await s.set('logging', logging)
}

export const setAnimations = async (animations: boolean) => {
  const s = await getStore()
  await s.set('animations', animations)
}

export const setReviewButtons = async (buttons: ActionButton[]) => {
  const s = await getStore()
  await s.set('reviewButtons', buttons)
}

export const setPrButtons = async (buttons: ActionButton[]) => {
  const s = await getStore()
  await s.set('prButtons', buttons)
}

export const setGithubUser = async (githubUser: string) => {
  const s = await getStore()
  await s.set('githubUser', githubUser)
}

export const setGithubName = async (githubName: string) => {
  const s = await getStore()
  await s.set('githubName', githubName)
}

export const setRepos = async (repos: WatchedRepo[]) => {
  const s = await getStore()
  await s.set('repos', repos)
}
