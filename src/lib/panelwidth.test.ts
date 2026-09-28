import { describe, expect, it } from 'vitest'
import { isTextField, stepPanelWidth } from './panelwidth'

describe('stepPanelWidth', () => {
  it('grows by 15% of the viewport', () => {
    expect(stepPanelWidth(500, 1, 1000)).toBe(650)
  })

  it('shrinks by 15% of the viewport', () => {
    expect(stepPanelWidth(700, -1, 1000)).toBe(550)
  })

  it('caps at 90% of the viewport', () => {
    expect(stepPanelWidth(800, 1, 1000)).toBe(900)
  })

  it('floors at 400px', () => {
    expect(stepPanelWidth(450, -1, 1000)).toBe(400)
  })
})

describe('isTextField', () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element

  it('matches inputs, textareas, selects and contenteditable', () => {
    expect(isTextField(el('INPUT'))).toBe(true)
    expect(isTextField(el('TEXTAREA'))).toBe(true)
    expect(isTextField(el('SELECT'))).toBe(true)
    expect(isTextField(el('DIV', true))).toBe(true)
  })

  it('ignores other elements and null', () => {
    expect(isTextField(el('BUTTON'))).toBe(false)
    expect(isTextField(null)).toBe(false)
  })
})
