import { describe, expect, it } from 'vitest'
import { frontmatter, matchSlash, pluginName, type SlashEntry, slashQuery } from './skills'

describe('frontmatter', () => {
  it('reads name and description', () => {
    expect(frontmatter('---\nname: rebase\ndescription: Rebase the current branch.\n---\n# Rebase')).toEqual({
      name: 'rebase',
      description: 'Rebase the current branch.',
    })
  })

  it('unquotes values and ignores other keys', () => {
    expect(frontmatter('---\nname: "cp"\nallowed-tools: Bash\ndescription: \'Commit and push\'\n---')).toEqual({
      name: 'cp',
      description: 'Commit and push',
    })
  })

  it('knows nothing without a frontmatter block', () => {
    expect(frontmatter('# Just a doc\ndescription: not this')).toEqual({ name: null, description: null })
  })
})

describe('pluginName', () => {
  it('drops the marketplace from an installed plugin key', () => {
    expect(pluginName('wazo@wazo-plugins')).toBe('wazo')
    expect(pluginName('solo')).toBe('solo')
  })
})

describe('slashQuery', () => {
  const at = (text: string) => slashQuery(text, text.length)

  it('opens on a / at the start or after a space', () => {
    expect(at('/')).toEqual({ start: 0, query: '' })
    expect(at('#app /reb')).toEqual({ start: 5, query: 'reb' })
    expect(at('/wazo:create')).toEqual({ start: 0, query: 'wazo:create' })
  })

  it('stays shut inside a path or a URL, and once the command is done', () => {
    expect(at('src/lib')).toBeNull()
    expect(at('https://x.io/')).toBeNull()
    expect(at('/rebase ')).toBeNull()
  })
})

describe('matchSlash', () => {
  const entries: SlashEntry[] = [
    { name: 'rebase', description: 'Rebase on main', kind: 'skill' },
    { name: 'do-review', description: 'Review a PR', kind: 'command' },
    { name: 'wazo:create-bug', description: 'Create a bug', kind: 'skill' },
  ]
  const names = (q: string) => matchSlash(q, entries).map((e) => e.name)

  it('lists everything for a bare /', () => expect(names('')).toEqual(['do-review', 'rebase', 'wazo:create-bug']))

  it('ranks names starting with the query first, then names containing it', () => {
    expect(names('re')).toEqual(['rebase', 'do-review', 'wazo:create-bug'])
  })

  it('matches the plugin-less part of a namespaced name as a start', () => {
    expect(names('create')).toEqual(['wazo:create-bug'])
  })
})
