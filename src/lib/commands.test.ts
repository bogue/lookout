import { describe, expect, it, vi } from 'vitest'

// path -> entries; a dir lists its children, a file is a leaf
const tree: Record<string, { name: string; isFile: boolean; isDirectory: boolean }[]> = {
  '/home/.claude/commands': [{ name: 'cp.md', isFile: true, isDirectory: false }],
  '/home/.claude/skills': [
    { name: 'fix-typo', isFile: false, isDirectory: true },
    { name: 'not-a-skill', isFile: false, isDirectory: true },
    { name: 'README.md', isFile: true, isDirectory: false },
  ],
  '/home/.claude/skills/fix-typo': [{ name: 'SKILL.md', isFile: true, isDirectory: false }],
  '/home/.claude/skills/not-a-skill': [{ name: 'notes.md', isFile: true, isDirectory: false }],
  '/repo/.claude/skills': [{ name: 'e2e', isFile: false, isDirectory: true }],
  '/repo/.claude/skills/e2e': [{ name: 'SKILL.md', isFile: true, isDirectory: false }],
}

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home',
  join: async (...parts: string[]) => parts.join('/'),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (p: string) => p in tree,
  readDir: async (p: string) => tree[p] ?? [],
}))

import { listSlashCommands } from './commands'

describe('listSlashCommands', () => {
  it('lists user and repo skills next to commands, sorted', async () => {
    expect(await listSlashCommands(['/repo'])).toEqual(['cp', 'e2e', 'fix-typo'])
  })

  it('skips a skills subdir with no SKILL.md', async () => {
    expect(await listSlashCommands([])).not.toContain('not-a-skill')
  })
})
