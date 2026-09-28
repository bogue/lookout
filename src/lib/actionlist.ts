import type { ActionButton, ButtonCondition } from '../types'

// Small pure helpers behind the Settings action list and editor.

// "Show when" in a word: no rule means the action is always shown
export const rulesLabel = (conditions: ButtonCondition[]): string =>
  conditions.length === 0 ? 'Always' : `${conditions.length} rule${conditions.length > 1 ? 's' : ''}`

// Drag-and-drop: put action `id` right before `beforeId` (null = at the end). Order matters: the
// first action is the primary, the one the card's quick shortcut runs. A drop that wouldn't move it
// (onto itself, or just before the one already after it) returns the same list.
export const dropAction = (list: ActionButton[], id: string, beforeId: string | null): ActionButton[] => {
  const from = list.findIndex((b) => b.id === id)
  if (from < 0 || beforeId === id || (beforeId !== null && list[from + 1]?.id === beforeId)) return list
  if (beforeId === null && from === list.length - 1) return list
  const rest = list.filter((b) => b.id !== id)
  const at = beforeId === null ? rest.length : rest.findIndex((b) => b.id === beforeId)
  return [...rest.slice(0, at), list[from], ...rest.slice(at)]
}

// The editor's "insert" chips: put a placeholder at the end of the prompt, one space before it
export const appendToken = (prompt: string, token: string): string =>
  prompt === '' ? token : `${prompt.replace(/\s+$/, '')} ${token}`
