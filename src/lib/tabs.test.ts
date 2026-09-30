import { describe, expect, it } from 'vitest'
import { TAB_ORDER, tabForKey } from './tabs'

describe('TAB_ORDER', () => {
  it('puts Stream right before Discovery', () => {
    expect(TAB_ORDER.map((t) => t.view)).toEqual(['pulls', 'board', 'stream', 'discovery', 'settings'])
  })
})

describe('tabForKey', () => {
  it('maps ⌘1..⌘n to the tab at that position', () => {
    expect(tabForKey('1')).toBe('pulls')
    expect(tabForKey('3')).toBe('stream')
    expect(tabForKey('4')).toBe('discovery')
    expect(tabForKey('5')).toBe('settings')
  })

  it('ignores keys with no tab', () => {
    expect(tabForKey('0')).toBeNull()
    expect(tabForKey('6')).toBeNull()
    expect(tabForKey('k')).toBeNull()
  })
})
