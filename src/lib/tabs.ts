export type View = 'pulls' | 'board' | 'stream' | 'discovery' | 'settings'

// Single source of truth for tab order: shortcuts (⌘1..⌘n) derive from the index
export const TAB_ORDER: { view: View; label: string }[] = [
  { view: 'pulls', label: 'Pull Requests' },
  { view: 'board', label: 'Reviews' },
  { view: 'stream', label: 'Stream' },
  { view: 'discovery', label: 'Discovery' },
  { view: 'settings', label: 'Settings' },
]

// the tab a ⌘<key> shortcut switches to, or null when the key has no tab
export const tabForKey = (key: string): View | null => {
  if (!/^[1-9]$/.test(key)) return null
  return TAB_ORDER[Number(key) - 1]?.view ?? null
}
