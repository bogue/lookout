import { homeDir, join } from '@tauri-apps/api/path'
import { exists, readDir } from '@tauri-apps/plugin-fs'

// Slash commands are `.md` files under a `commands` dir. A top-level file `foo.md` is `/foo`;
// a file in a subdir `ns/foo.md` is the namespaced `/ns:foo` (one level, matching Claude Code).
const scanCommandsDir = async (dir: string): Promise<string[]> => {
  if (!(await exists(dir).catch(() => false))) return []
  const names: string[] = []
  for (const entry of await readDir(dir).catch(() => [])) {
    if (entry.isFile && entry.name.endsWith('.md')) names.push(entry.name.replace(/\.md$/, ''))
    else if (entry.isDirectory) {
      const sub = await join(dir, entry.name)
      for (const child of await readDir(sub).catch(() => [])) {
        if (child.isFile && child.name.endsWith('.md')) names.push(`${entry.name}:${child.name.replace(/\.md$/, '')}`)
      }
    }
  }
  return names
}

// Skills are dirs under a `skills` dir holding a `SKILL.md`: `skills/foo/SKILL.md` is `/foo`.
const scanSkillsDir = async (dir: string): Promise<string[]> => {
  if (!(await exists(dir).catch(() => false))) return []
  const names: string[] = []
  for (const entry of await readDir(dir).catch(() => [])) {
    if (!entry.isDirectory) continue
    const files = await readDir(await join(dir, entry.name)).catch(() => [])
    if (files.some((f) => f.isFile && f.name === 'SKILL.md')) names.push(entry.name)
  }
  return names
}

// User commands and skills (~/.claude) plus each watched repo's project ones (.claude),
// de-duplicated and sorted. Names carry no leading slash — the editor prepends it.
export const listSlashCommands = async (repoPaths: string[]): Promise<string[]> => {
  const roots = [
    await join(await homeDir(), '.claude'),
    ...(await Promise.all(repoPaths.map((p) => join(p, '.claude')))),
  ]
  const lists = await Promise.all(
    roots.flatMap((r) => [join(r, 'commands').then(scanCommandsDir), join(r, 'skills').then(scanSkillsDir)]),
  )
  return [...new Set(lists.flat())].sort()
}
