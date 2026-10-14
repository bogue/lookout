import type { MergeHook } from '../types'
import { fillPrompt } from './prompt'

// The run label of a prompt sent on merge: like a chat, its answer is never saved as a report
export const MERGE_HOOK_COMMAND = 'On merge'

export const DEFAULT_MERGE_HOOK: MergeHook = { enabled: false, prompt: '' }

// a stored hook back to a hook, field by field (a hand-edited config can't break the merge)
export const readMergeHook = (v: unknown): MergeHook => {
  const h = (v ?? {}) as Partial<Record<keyof MergeHook, unknown>>
  return {
    enabled: typeof h.enabled === 'boolean' ? h.enabled : DEFAULT_MERGE_HOOK.enabled,
    prompt: typeof h.prompt === 'string' ? h.prompt : DEFAULT_MERGE_HOOK.prompt,
  }
}

// What to send for this PR; null = the hook is off or empty, nothing runs
export const mergeHookText = (h: MergeHook, branch: string, prNumber: number): string | null =>
  h.enabled && h.prompt.trim() ? fillPrompt(h.prompt.trim(), branch, prNumber) : null
