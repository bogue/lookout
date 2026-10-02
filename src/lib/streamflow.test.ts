import { describe, expect, it } from 'vitest'
import { advance, DEFAULT_TEMPLATES, fillStep, parseSteps, type TemplateStep } from './streamflow'

const steps: TemplateStep[] = [
  { prompt: 'Plan <title>', gate: true },
  { prompt: 'Implement it', gate: false },
  { prompt: '/do-followup <pr_id>', gate: true, waitFor: 'author_pushed' },
]

describe('fillStep', () => {
  it('fills the placeholders and appends the guidelines', () => {
    const text = fillStep(
      { prompt: 'Review #<pr_id> on <branch_name>: <title>', gate: true },
      { title: 'login fix', ref: 'owner/app#42', branch: 'fix-login' },
      'Use conventional commits.',
    )
    expect(text).toBe('Review #42 on fix-login: login fix\n\nGuidelines:\nUse conventional commits.')
  })

  it('leaves a placeholder it cannot fill as is', () => {
    expect(fillStep({ prompt: '/review <pr_id>', gate: true }, { title: 't', ref: null, branch: null }, null)).toBe(
      '/review <pr_id>',
    )
  })
})

describe('advance', () => {
  it('goes to the next step after a step I approved', () => {
    expect(advance(steps, 0)).toEqual({ kind: 'next', index: 1, waitFor: undefined })
  })

  it('waits on GitHub first when the next step says so', () => {
    expect(advance(steps, 1)).toEqual({ kind: 'next', index: 2, waitFor: 'author_pushed' })
  })

  it('finishes after the last step', () => {
    expect(advance(steps, 2)).toEqual({ kind: 'done' })
  })

  it('finishes a card with no steps (a plain dump) on the first approval', () => {
    expect(advance([], 0)).toEqual({ kind: 'done' })
  })
})

describe('parseSteps', () => {
  it('reads stored steps and drops broken ones', () => {
    expect(
      parseSteps(JSON.stringify([{ prompt: 'a', gate: false }, { prompt: '' }, { prompt: 'b', waitFor: 'nope' }])),
    ).toEqual([
      { prompt: 'a', gate: false },
      { prompt: 'b', gate: true },
    ])
  })

  it('is no steps for anything else', () => {
    expect(parseSteps('not json')).toEqual([])
    expect(parseSteps('{}')).toEqual([])
  })
})

describe('DEFAULT_TEMPLATES', () => {
  it('ships the three flows, each ending on a step I approve', () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.name)).toEqual(['Implement card', 'Review cycle', 'Handle my PR feedback'])
    for (const t of DEFAULT_TEMPLATES) expect(t.steps.at(-1)?.gate).toBe(true)
  })
})
