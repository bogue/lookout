import { Command } from '@tauri-apps/plugin-shell'
import type { StreamItem } from '../types'
import { errText, logWarn } from './log'

// Risk check: whether a card may start on its own (Auto-run) or waits for my OK. Only for a card's
// first start without me — Run now is my call, and a card that already ran was let through once.
// Local rules catch the outward-facing words for sure; Haiku judges the rest. Fail closed: no clear
// answer is risky. The agent's tools can't push or publish anyway (streamrun.ts STREAM_DENY): this
// is about what the task *asks*, so it never starts something I'd want to see first.

export type Risk = { risky: boolean; reason: string }

type Card = Pick<
  StreamItem,
  'title' | 'body' | 'steps' | 'guidelines' | 'gate' | 'stepIndex' | 'sessionIds' | 'waitFor'
>

// everything the agent will be told
export const riskText = (x: Card) =>
  [x.title, x.body, ...x.steps.map((s) => s.prompt), x.guidelines].filter(Boolean).join('\n')

export const needsRiskCheck = (x: Card) =>
  x.gate !== 'risk-ok' && x.stepIndex === 0 && !x.sessionIds.length && !x.waitFor

// words that mean the task reaches past the worktree: risky without asking
const OUTWARD: [RegExp, string][] = [
  [/\b(release|publish|deploy|ship to)\b/i, 'it publishes or deploys'],
  [/\b(tag)\s+v?\d/i, 'it tags a version'],
  [/\bmerge\b/i, 'it merges'],
  [/\b(force[- ]?)?push\b/i, 'it pushes'],
  [/\bprod(uction)?\b/i, 'it touches production'],
  [/\b(post|leave|add)\b.{0,20}\bcomments?\b|\bcomment on\b/i, 'it comments on GitHub'],
  [/\bapprove\b.{0,20}\b(pr|pull request)\b|\bgh pr review\b/i, 'it reviews on GitHub'],
  [/\b(notion|jira|slack|email|e-mail|linear)\b/i, 'it acts on an outside service'],
  [/\b(delete|drop|wipe|purge)\b|\brm -rf\b/i, 'it deletes things'],
]

// what the task forbids isn't what it asks: "never push", "do not merge", "without pushing"
const FORBIDDEN = /\b(never|do not|don't|dont|no|without|not)\s+(\w+ing\s+)?(?=\w)/gi

export const localRisk = (x: Card): Risk | null => {
  const text = riskText(x).replace(new RegExp(`${FORBIDDEN.source}\\w+`, 'gi'), ' ')
  for (const [re, why] of OUTWARD) if (re.test(text)) return { risky: true, reason: `Needs your OK: ${why}` }
  return null
}

const PROMPT = (
  text: string,
) => `An AI coding agent is about to start this task on its own, in a git worktree of a local repository. It can read and edit files and commit locally; it cannot push.

Is it safe to start without asking me first? It's "risky" when it would reach anything outside that worktree — publishing, deploying, messaging people, outside services, deleting data, money, credentials — or when it's unclear what it would do. Plain local code work (implementing, fixing, refactoring, testing, reviewing) is "safe".

Answer with JSON only: {"risk": "safe" | "risky", "reason": "<one short line>"}

<task>
${text.slice(0, 6000)}
</task>`

const UNCLEAR: Risk = { risky: true, reason: 'Haiku gave no clear verdict' }

export const parseRisk = (text: string): Risk => {
  const json = text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1')
  try {
    const v = JSON.parse(json)
    if (v?.risk !== 'safe' && v?.risk !== 'risky') return UNCLEAR
    const reason = typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim().slice(0, 200) : ''
    return { risky: v.risk === 'risky', reason: reason || (v.risk === 'safe' ? 'local work' : 'unclear') }
  } catch {
    return UNCLEAR
  }
}

// Haiku's verdicts by the exact task text: a Watcher firing the same template on many PRs costs one
// call. Failures aren't kept, so a rate limit only delays the card.
const verdicts = new Map<string, Risk>()

export const assessRisk = async (x: Card): Promise<Risk> => {
  const local = localRisk(x)
  if (local) return local
  const text = riskText(x)
  const known = verdicts.get(text)
  if (known) return known
  try {
    const out = await Command.create('claude', [
      '-p',
      PROMPT(text),
      '--model',
      'haiku',
      '--tools',
      '', // a verdict needs no tools
      '--no-session-persistence', // or the checker's own transcript would show up as a session
    ]).execute()
    if (out.code !== 0) {
      logWarn('stream', `risk: claude exited ${out.code}: ${out.stderr?.trim() ?? ''}`)
      return { risky: true, reason: 'The risk check could not run (claude failed)' }
    }
    const v = parseRisk(out.stdout)
    if (v !== UNCLEAR) verdicts.set(text, v)
    return v
  } catch (e) {
    logWarn('stream', `risk: ${errText(e)}`)
    return { risky: true, reason: 'The risk check could not run' }
  }
}
