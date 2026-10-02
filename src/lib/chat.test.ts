import { describe, expect, it } from 'vitest'
import { chatPrompt, parseChatPrompt } from './chat'

describe('chatPrompt', () => {
  it('names the PR and its branch, then the question', () => {
    expect(chatPrompt(42, 'acme/app', 'feat/login', 'is this still needed?')).toBe(
      'About PR #42 in acme/app (branch feat/login):\n\nis this still needed?',
    )
  })
})

describe('parseChatPrompt', () => {
  it('reads back what chatPrompt wrote', () => {
    expect(parseChatPrompt(chatPrompt(42, 'acme/app', 'feat/login', 'is this still needed?'))).toEqual({
      prNumber: 42,
      branch: 'feat/login',
      question: 'is this still needed?',
    })
  })

  it('keeps the first line of the question, cut short', () => {
    const long = `${'a'.repeat(100)}\nsecond line`
    expect(parseChatPrompt(chatPrompt(1, 'acme/app', 'b', long))?.question).toBe(`${'a'.repeat(80)}…`)
  })

  // chats started before the wording changed still belong to their card
  it('accepts the older ", checked out here" wording', () => {
    expect(parseChatPrompt('About PR #7 in acme/app (branch fix-x, checked out here):\n\nhello')).toMatchObject({
      prNumber: 7,
      branch: 'fix-x',
    })
  })

  it('is null for anything else', () => {
    expect(parseChatPrompt('please review this')).toBeNull()
    expect(parseChatPrompt('Notes: About PR #7 in acme/app (branch x):\n\nhi')).toBeNull()
  })
})
