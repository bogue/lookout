import { Command } from '@tauri-apps/plugin-shell'
import { errText, logWarn } from './log'

// After an agent's result, Haiku reads it and proposes what I do next — push and open a PR, answer
// the question it asked, ask for a fix, or call it done — as buttons. A button either sends its reply
// into the session (shown on the button, so I see exactly what goes out) or marks the card done.
// Advice only: nothing happens until I click.

export type NextAction = { label: string; reply: string | null } // reply null = mark done
export type NextStep = { headline: string; actions: NextAction[] }

const MAX_INPUT = 8 * 1024
const MAX_ACTIONS = 3

const PROMPT = (
  task: string,
  result: string,
) => `An AI coding agent worked on a task in a git worktree and stopped for my review. It was told not to push or publish anything on its own.

Decide what I most likely want to do next and offer it as buttons. Typical next steps: push and open a draft PR, answer a question the agent asked (one button per plausible answer), ask it to fix something it got wrong or left open, or mark the task done when nothing is left.

Answer with JSON only, no prose:
{"headline": "<one line: where the task stands>", "actions": [{"label": "<2-6 words>", "reply": "<the exact message to send to the agent>"}, {"label": "Done", "done": true}]}
At most ${MAX_ACTIONS} actions, the most likely first. Use "done": true instead of "reply" only for marking the task finished.

<task>
${task}
</task>

<agent_result>
${result.slice(0, MAX_INPUT)}
</agent_result>`

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

// Haiku's answer → the step, or null when it isn't the expected shape or offers nothing usable
export const parseNextStep = (text: string): NextStep | null => {
  const json = text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1')
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const o = v as { headline?: unknown; actions?: unknown }
  const actions = (Array.isArray(o.actions) ? o.actions : [])
    .flatMap((a): NextAction[] => {
      const label = str(a?.label, 60)
      if (!label) return []
      // "done": true, or an explicit null reply (Haiku's usual way of writing the Done button)
      if (a?.done === true || a?.reply === null) return [{ label, reply: null }]
      const reply = str(a?.reply, 2000)
      return reply ? [{ label, reply }] : []
    })
    .slice(0, MAX_ACTIONS)
  if (!actions.length) return null
  return { headline: str(o.headline, 200) ?? '', actions }
}

// the suggestion that belongs to the latest result: saved after it, before any newer turn
export const nextStepOf = (events: { kind: string; text: string | null }[]): NextStep | null => {
  const at = events.map((e) => e.kind).lastIndexOf('result')
  if (at < 0) return null
  const next = events.slice(at + 1).find((e) => e.kind === 'next')
  return next?.text ? parseNextStep(next.text) : null
}

export const suggestNextStep = async (
  item: { title: string; body: string | null; ref: string | null },
  result: string,
): Promise<NextStep | null> => {
  const task = [item.title, item.ref ? `Reference: ${item.ref}` : null, item.body ? `Notes: ${item.body}` : null]
    .filter(Boolean)
    .join('\n')
  try {
    const out = await Command.create('claude', [
      '-p',
      PROMPT(task, result),
      '--model',
      'haiku',
      '--tools',
      '', // advice needs no tools
      '--no-session-persistence', // or the adviser's own transcript would show up as a session
    ]).execute()
    if (out.code !== 0) {
      logWarn('stream', `next step: claude exited ${out.code}: ${out.stderr?.trim() ?? ''}`)
      return null
    }
    return parseNextStep(out.stdout)
  } catch (e) {
    logWarn('stream', `next step: ${errText(e)}`)
    return null
  }
}
