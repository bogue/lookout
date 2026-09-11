import { join } from '@tauri-apps/api/path'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { listWorktrees } from './worktrees'

// Review exports: AI_TASKS/code-review/YYYY-MM-DD-HH-MM-<branch>.md.
// Branches with "/" nest the file one level down (Write creates the dir), so scan one sublevel too.
const listFiles = async (dir: string): Promise<string[]> => {
  const names: string[] = []
  for (const entry of await readDir(dir)) {
    if (entry.isFile) names.push(entry.name)
    else if (entry.isDirectory) {
      try {
        for (const sub of await readDir(await join(dir, entry.name))) {
          if (sub.isFile) names.push(`${entry.name}/${sub.name}`)
        }
      } catch {
        // unreadable subdir: skip
      }
    }
  }
  return names
}

// Map branch -> review file paths. A review run in a worktree writes its report there, so every
// checkout of the repo is scanned, not just the clone.
export const scanReviewFiles = async (repoPath: string): Promise<Map<string, string[]>> => {
  const byBranch = new Map<string, string[]>()
  for (const w of await listWorktrees(repoPath)) {
    const dir = await join(w.path, 'AI_TASKS', 'code-review')
    if (!(await exists(dir))) continue
    for (const name of await listFiles(dir)) {
      const m = name.match(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-(.+)\.md$/)
      if (!m) continue
      const branch = m[1]
      const files = byBranch.get(branch) ?? []
      files.push(await join(dir, name))
      byBranch.set(branch, files)
    }
  }
  return byBranch
}
