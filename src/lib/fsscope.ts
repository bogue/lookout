import { invoke } from '@tauri-apps/api/core'

// The capability file can only allow paths that exist at build time, so it covers `~/.claude` and
// nothing else a user might watch. Registered clones and their worktrees live wherever the user
// keeps them, so each checkout is handed to the runtime fs scope the first time it is touched —
// otherwise reading `AI_TASKS/code-review` out of it is a forbidden path.
const allowed = new Set<string>()

export const allowPath = async (path: string): Promise<void> => {
  if (allowed.has(path)) return
  allowed.add(path)
  try {
    await invoke('allow_path', { path })
  } catch {
    // a failed widen would otherwise be cached as done: drop it so the next sync retries
    allowed.delete(path)
  }
}
