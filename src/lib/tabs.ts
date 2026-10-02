export type View = 'pulls' | 'board' | 'stream' | 'discovery' | 'settings'

// Single source of truth for tab order: shortcuts (⌘1..⌘n) derive from the index of the visible ones
export const TAB_ORDER: { view: View; label: string }[] = [
  { view: 'pulls', label: 'Pull Requests' },
  { view: 'board', label: 'Reviews' },
  { view: 'stream', label: 'Stream' },
  { view: 'discovery', label: 'Discovery' },
  { view: 'settings', label: 'Settings' },
]

// Stream is a beta behind a Settings flag: off, its tab is gone and the shortcuts close up
export const visibleTabs = (streamEnabled: boolean) => TAB_ORDER.filter((t) => streamEnabled || t.view !== 'stream')

// the tab a ⌘<key> shortcut switches to among the visible ones, or null when the key has no tab
export const tabForKey = (key: string, tabs: typeof TAB_ORDER): View | null => {
  if (!/^[1-9]$/.test(key)) return null
  return tabs[Number(key) - 1]?.view ?? null
}
