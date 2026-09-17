import { invoke } from '@tauri-apps/api/core'

// The capability file can only allow paths that exist at build time, so it covers `~/.claude` and
// nothing else a user might watch. Registered clones and their worktrees live wherever the user
// keeps them, so each checkout is handed to the runtime fs scope the first time it is touched —
// otherwise reading `AI_TASKS/code-review` out of it is a forbidden path.
// What is cached is the widen itself, not a "done" flag: the first sync of a repo asks for the
// same checkout twice at once (sessions + reviews), and the second caller has to wait on the
// widen already in flight or it reads against a scope that isn't open yet.
const widened = new Map<string, Promise<void>>()

export const allowPath = (path: string): Promise<void> => {
  const inflight = widened.get(path)
  if (inflight) return inflight
  const widen = invoke<void>('allow_path', { path }).catch(() => {
    // a failed widen would otherwise be cached as done: drop it so the next sync retries
    widened.delete(path)
  })
  widened.set(path, widen)
  return widen
}
