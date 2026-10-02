import { describe, expect, it } from 'vitest'
import { TAB_ORDER, tabForKey, visibleTabs } from './tabs'

describe('TAB_ORDER', () => {
  it('puts Stream right before Discovery', () => {
    expect(TAB_ORDER.map((t) => t.view)).toEqual(['pulls', 'board', 'stream', 'discovery', 'settings'])
  })
})

describe('visibleTabs', () => {
  it('shows Stream only when its beta flag is on', () => {
    expect(visibleTabs(true).map((t) => t.view)).toEqual(['pulls', 'board', 'stream', 'discovery', 'settings'])
    expect(visibleTabs(false).map((t) => t.view)).toEqual(['pulls', 'board', 'discovery', 'settings'])
  })
})

describe('tabForKey', () => {
  it('maps ⌘1..⌘n to the tab at that position', () => {
    const tabs = visibleTabs(true)
    expect(tabForKey('1', tabs)).toBe('pulls')
    expect(tabForKey('3', tabs)).toBe('stream')
    expect(tabForKey('4', tabs)).toBe('discovery')
    expect(tabForKey('5', tabs)).toBe('settings')
  })

  it('follows the visible tabs: with Stream off, Discovery is back on ⌘3', () => {
    const tabs = visibleTabs(false)
    expect(tabForKey('3', tabs)).toBe('discovery')
    expect(tabForKey('4', tabs)).toBe('settings')
    expect(tabForKey('5', tabs)).toBeNull()
  })

  it('ignores keys with no tab', () => {
    const tabs = visibleTabs(true)
    expect(tabForKey('0', tabs)).toBeNull()
    expect(tabForKey('6', tabs)).toBeNull()
    expect(tabForKey('k', tabs)).toBeNull()
  })
})
