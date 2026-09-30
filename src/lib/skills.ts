import { homeDir, join } from '@tauri-apps/api/path'
import { exists, readDir, readTextFile } from '@tauri-apps/plugin-fs'

// What `/` offers in the Stream dump: every skill and slash command Claude Code would take in one of
// my projects. Skills are `<dir>/<name>/SKILL.md`, commands `<dir>/<name>.md` (a subdir `ns/foo.md`
// is `/ns:foo`, as in lib/commands.ts). Plugin entries are namespaced `plugin:name`.

export type SlashEntry = { name: string; description: string | null; kind: 'skill' | 'command' }

// the `name:` and `description:` of a markdown file's frontmatter
export const frontmatter = (md: string): { name: string | null; description: string | null } => {
  const block = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const read = (key: string) => {
    const m = block?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null
  }
  return { name: read('name'), description: read('description') }
}

// installed_plugins.json keys are `plugin@marketplace`; the command namespace is the plugin
export const pluginName = (key: string) => key.split('@')[0]

// the `/command` being typed at the caret: at the start or after a space, so paths and URLs stay shut
export const slashQuery = (text: string, caret: number): { start: number; query: string } | null => {
  const m = text.slice(0, caret).match(/(^|\s)\/([\w:.-]*)$/)
  if (!m || m.index === undefined) return null
  return { start: m.index + m[1].length, query: m[2] }
}

// entries matching the query: a name (or its part after `plugin:`) starting with it first, then any
// name containing it; alphabetical within each group
export const matchSlash = (query: string, entries: SlashEntry[]): SlashEntry[] => {
  const q = query.toLowerCase()
  const score = (e: SlashEntry) => {
    const n = e.name.toLowerCase()
    if (n.startsWith(q) || n.split(':')[1]?.startsWith(q)) return 0
    return n.includes(q) ? 1 : 2
  }
  return entries
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s < 2)
    .sort((a, b) => a.s - b.s || a.e.name.localeCompare(b.e.name))
    .map((x) => x.e)
}

const readMd = (path: string) => readTextFile(path).catch(() => '')

const scanSkills = async (dir: string, ns: string | null): Promise<SlashEntry[]> => {
  if (!(await exists(dir).catch(() => false))) return []
  const out: SlashEntry[] = []
  for (const entry of await readDir(dir).catch(() => [])) {
    if (!entry.isDirectory) continue
    const file = await join(dir, entry.name, 'SKILL.md')
    if (!(await exists(file).catch(() => false))) continue // e.g. a sync folder, not a skill
    const meta = frontmatter(await readMd(file))
    const name = meta.name ?? entry.name
    out.push({ name: ns ? `${ns}:${name}` : name, description: meta.description, kind: 'skill' })
  }
  return out
}

const scanCommands = async (dir: string, ns: string | null): Promise<SlashEntry[]> => {
  if (!(await exists(dir).catch(() => false))) return []
  const out: SlashEntry[] = []
  const add = async (path: string, name: string) => {
    const { description } = frontmatter(await readMd(path))
    out.push({ name: ns ? `${ns}:${name}` : name, description, kind: 'command' })
  }
  for (const entry of await readDir(dir).catch(() => [])) {
    if (entry.isFile && entry.name.endsWith('.md')) await add(await join(dir, entry.name), entry.name.slice(0, -3))
    else if (entry.isDirectory) {
      const sub = await join(dir, entry.name)
      for (const child of await readDir(sub).catch(() => [])) {
        if (child.isFile && child.name.endsWith('.md'))
          await add(await join(sub, child.name), `${entry.name}:${child.name.slice(0, -3)}`)
      }
    }
  }
  return out
}

// plugin install dirs from ~/.claude/plugins/installed_plugins.json, with their namespace
const pluginDirs = async (home: string): Promise<{ ns: string; path: string }[]> => {
  const file = await join(home, '.claude', 'plugins', 'installed_plugins.json')
  try {
    const json = JSON.parse(await readTextFile(file)) as { plugins?: Record<string, { installPath?: string }[]> }
    return Object.entries(json.plugins ?? {}).flatMap(([key, installs]) =>
      installs.flatMap((i) => (i.installPath ? [{ ns: pluginName(key), path: i.installPath }] : [])),
    )
  } catch {
    return []
  }
}

// User, project (each watched clone) and plugin skills and commands; the first of a name wins, so a
// project's own entry never duplicates the user one.
export const listSlashEntries = async (repoPaths: string[]): Promise<SlashEntry[]> => {
  const home = await homeDir()
  const roots: { path: string; ns: string | null }[] = [
    { path: await join(home, '.claude'), ns: null },
    ...(await Promise.all(repoPaths.map(async (p) => ({ path: await join(p, '.claude'), ns: null })))),
    ...(await pluginDirs(home)),
  ]
  const lists = await Promise.all(
    roots.flatMap((r) => [
      join(r.path, 'skills').then((d) => scanSkills(d, r.ns)),
      join(r.path, 'commands').then((d) => scanCommands(d, r.ns)),
    ]),
  )
  const seen = new Set<string>()
  return lists.flat().filter((e) => !seen.has(e.name) && seen.add(e.name))
}
