import { isTrigger, type Trigger } from './streamwatch'

// Flow templates: a named list of steps, run one at a time in the card's session. A step I gate
// stops for my approval; approving moves on to the next step — after waiting on GitHub first when
// that step says so — and approving the last one finishes the card. A step with no gate moves on by
// itself. A card with no steps (a plain dump) is a one-step flow: approve = done.

export type TemplateStep = {
  prompt: string // a skill (/review <pr_id>) or a plain prompt; <pr_id> <branch_name> <title> filled in
  gate: boolean // stop for my approval after this step
  waitFor?: Trigger // wait on GitHub before this step starts
}

export type FlowTemplate = {
  id: string
  name: string
  steps: TemplateStep[]
  guidelines: string // rules appended to every step's prompt
}

export const DEFAULT_TEMPLATES: FlowTemplate[] = [
  {
    id: 'implement-card',
    name: 'Implement card',
    guidelines: 'Work test-first. Commit with conventional commit messages. Never push on your own.',
    steps: [
      {
        prompt:
          'Read the task (<title>) and the code it touches, then write a short implementation plan: files, approach, tests, risks. Do not change any code yet; end with the plan.',
        gate: true,
      },
      { prompt: 'The plan is approved. Implement it, with tests, and commit. End with a summary.', gate: true },
    ],
  },
  {
    id: 'review-cycle',
    name: 'Review cycle',
    guidelines: '',
    steps: [
      { prompt: 'Review pull request #<pr_id>: list the issues worth raising, most important first.', gate: true },
      {
        prompt:
          'The author pushed new commits on #<pr_id>. Follow up: for each earlier review point, say whether it is addressed, partly, or still pending.',
        gate: true,
        waitFor: 'author_pushed',
      },
    ],
  },
  {
    id: 'handle-my-pr-feedback',
    name: 'Handle my PR feedback',
    guidelines: 'Commit each fix separately. Never push on your own.',
    steps: [
      {
        prompt:
          'Someone reviewed my pull request #<pr_id>. Read the new review comments, address the ones that are right, and explain the ones you disagree with.',
        gate: true,
        waitFor: 'reviewed',
      },
    ],
  },
]

// A step's prompt for this card: placeholders filled when known, guidelines appended
export const fillStep = (
  step: TemplateStep,
  card: { title: string; ref: string | null; branch: string | null },
  guidelines: string | null,
): string => {
  const pr = card.ref?.match(/#(\d+)$/)?.[1]
  const text = step.prompt
    .replace(/<title>/g, card.title)
    .replace(/<pr_id>/g, pr ?? '<pr_id>')
    .replace(/<branch_name>/g, card.branch ?? '<branch_name>')
  return guidelines?.trim() ? `${text}\n\nGuidelines:\n${guidelines.trim()}` : text
}

// what follows the step at `index` once it's done (approved, or ungated)
export const advance = (
  steps: TemplateStep[],
  index: number,
): { kind: 'done' } | { kind: 'next'; index: number; waitFor: Trigger | undefined } => {
  const next = steps[index + 1]
  return next ? { kind: 'next', index: index + 1, waitFor: next.waitFor } : { kind: 'done' }
}

// stored steps (stream_items.steps, or a template from the config) back to steps; broken ones drop
export const parseSteps = (json: string | unknown): TemplateStep[] => {
  let v: unknown = json
  if (typeof json === 'string') {
    try {
      v = JSON.parse(json)
    } catch {
      return []
    }
  }
  if (!Array.isArray(v)) return []
  return v.flatMap((s): TemplateStep[] => {
    const prompt = typeof s?.prompt === 'string' ? s.prompt.trim() : ''
    if (!prompt) return []
    return [{ prompt, gate: s.gate !== false, ...(isTrigger(s.waitFor) ? { waitFor: s.waitFor } : {}) }]
  })
}
