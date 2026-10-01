import { describe, expect, it } from 'vitest'
import { parseProposal, proposalOf, SHAPE_DENY, SHAPE_TOOLS, shapePrompt } from './streamshape'

describe('shapePrompt', () => {
  it('asks for questions first, then a fenced JSON proposal of cards', () => {
    const p = shapePrompt({ title: 'automate the weekly release', body: null, repo: 'owner/app' })
    expect(p).toContain('automate the weekly release')
    expect(p).toContain('owner/app')
    expect(p).toMatch(/ask/i)
    expect(p).toContain('```json')
  })
})

describe('shape tools', () => {
  it('reads only', () => {
    expect(SHAPE_TOOLS.split(',')).not.toContain('Edit')
    expect(SHAPE_TOOLS.split(',')).not.toContain('Write')
    expect(SHAPE_DENY.split(',')).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'Bash(git commit:*)', 'Bash(git push:*)']),
    )
  })
})

describe('parseProposal', () => {
  it('reads the cards out of the fenced JSON block', () => {
    const text = `Here is the plan.\n\n\`\`\`json\n${JSON.stringify({
      summary: 'Two steps',
      cards: [
        { title: 'Add a release script', notes: 'scripts/release.sh, bump + tag' },
        { title: 'Schedule it weekly' },
      ],
    })}\n\`\`\`\nAnything else?`
    expect(parseProposal(text)).toEqual({
      summary: 'Two steps',
      cards: [
        { title: 'Add a release script', notes: 'scripts/release.sh, bump + tag' },
        { title: 'Schedule it weekly', notes: null },
      ],
    })
  })

  it('is no proposal when the agent only asked questions', () => {
    expect(parseProposal('Before I plan: is the release on main or a branch?')).toBeNull()
  })

  it('drops cards without a title, and is no proposal without any', () => {
    expect(parseProposal('```json\n{"cards":[{"title":""},{"notes":"x"}]}\n```')).toBeNull()
  })
})

describe('proposalOf', () => {
  it('reads the latest proposal of the trail, only if nothing newer was said after it', () => {
    const p = '{"summary":"s","cards":[{"title":"a"}]}'
    expect(proposalOf([{ kind: 'proposal', text: p }])?.cards).toEqual([{ title: 'a', notes: null }])
    expect(
      proposalOf([
        { kind: 'proposal', text: p },
        { kind: 'reply', text: 'change it' },
      ]),
    ).toBeNull()
  })
})
