import { describe, expect, it } from 'vitest'
import { DEFAULT_MERGE_HOOK, mergeHookText, readMergeHook } from './mergehook'

describe('readMergeHook', () => {
  it('falls back to an off, empty hook when nothing is stored', () => {
    expect(readMergeHook(undefined)).toEqual(DEFAULT_MERGE_HOOK)
    expect(readMergeHook(null)).toEqual(DEFAULT_MERGE_HOOK)
    expect(DEFAULT_MERGE_HOOK.enabled).toBe(false)
  })

  it('keeps a stored hook as is', () => {
    const h = { enabled: true, prompt: '/clean-worktrees' }
    expect(readMergeHook(h)).toEqual(h)
  })

  it('repairs a hand-edited hook field by field', () => {
    expect(readMergeHook({ enabled: 'yes', prompt: 3 })).toEqual(DEFAULT_MERGE_HOOK)
    expect(readMergeHook({ prompt: '/cleanup' })).toEqual({ enabled: false, prompt: '/cleanup' })
  })
})

describe('mergeHookText', () => {
  it('fills the placeholders of an enabled hook', () => {
    expect(mergeHookText({ enabled: true, prompt: '/clean <branch_name> #<pr_id>' }, 'feat-x', 7)).toBe(
      '/clean feat-x #7',
    )
  })

  it('is null when the hook is off or has nothing to send', () => {
    expect(mergeHookText({ enabled: false, prompt: '/clean' }, 'b', 1)).toBeNull()
    expect(mergeHookText({ enabled: true, prompt: '   ' }, 'b', 1)).toBeNull()
  })
})
