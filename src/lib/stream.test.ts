import { describe, expect, it } from 'vitest'
import type { StreamItem, StreamStatus } from '../types'
import {
  applyStreamAction,
  columnOf,
  dropStatus,
  dumpRef,
  entryRank,
  isNoMove,
  movedIds,
  parseDump,
  projectGate,
  projectGateTarget,
  prRefOf,
  sortColumn,
  streamActions,
  tagFor,
  tagQuery,
  tagSuggestions,
} from './stream'

describe('tagQuery', () => {
  const at = (text: string) => tagQuery(text, text.length)

  it('opens on a # just typed, at the start or after a space', () => {
    expect(at('#')).toEqual({ start: 0, query: '' })
    expect(at('fix login #')).toEqual({ start: 10, query: '' })
  })

  it('carries what follows the #', () => {
    expect(at('fix #wa')).toEqual({ start: 4, query: 'wa' })
    expect(at('#TinxHQ/wa')).toEqual({ start: 0, query: 'TinxHQ/wa' })
  })

  it('stays shut for a PR number, inside a word, or once the tag is done', () => {
    expect(at('follow up on #2')).toBeNull()
    expect(at('issue#')).toBeNull()
    expect(at('#app ')).toBeNull()
    expect(at('plain text')).toBeNull()
  })

  it('reads the text before the caret only', () => {
    expect(tagQuery('#ap fix', 3)).toEqual({ start: 0, query: 'ap' })
  })
})

describe('tagSuggestions', () => {
  const repos = ['TinxHQ/wazo-mobile-native', 'TinxHQ/wazo-desktop', 'acme/api']

  it('lists every project for a bare #', () => {
    expect(tagSuggestions('', repos)).toEqual(repos)
  })

  it('ranks names starting with the query before names containing it, ignoring case', () => {
    expect(tagSuggestions('WAZO', repos)).toEqual(['TinxHQ/wazo-mobile-native', 'TinxHQ/wazo-desktop'])
    expect(tagSuggestions('mobile', repos)).toEqual(['TinxHQ/wazo-mobile-native'])
    expect(tagSuggestions('a', repos)).toEqual(['acme/api', 'TinxHQ/wazo-mobile-native', 'TinxHQ/wazo-desktop'])
  })

  it('matches on the owner too', () => {
    expect(tagSuggestions('acme/', repos)).toEqual(['acme/api'])
  })
})

describe('tagFor', () => {
  it('uses the short name when no other project shares it', () => {
    expect(tagFor('acme/api', ['acme/api', 'owner/app'])).toBe('api')
  })

  it('uses owner/repo when the short name is ambiguous', () => {
    expect(tagFor('acme/app', ['acme/app', 'owner/app'])).toBe('acme/app')
  })
})

describe('prRefOf', () => {
  it('splits owner/repo#n into its PR', () => {
    expect(prRefOf('acme/api#57')).toEqual({ repo: 'acme/api', number: 57, url: 'https://github.com/acme/api/pull/57' })
  })

  it('returns null for anything else', () => {
    expect(prRefOf('https://www.notion.so/x')).toBeNull()
  })
})

const REPOS = ['owner/app', 'acme/api']

const item = (over: Partial<StreamItem> = {}): StreamItem => ({
  id: 'a',
  repo: 'owner/app',
  groupId: null,
  title: 'Do the thing',
  body: null,
  refKind: null,
  ref: null,
  status: 'idea',
  gate: null,
  sortOrder: null,
  priority: null,
  priorityReason: null,
  prioritySource: null,
  branch: null,
  checkout: null,
  sessionIds: [],
  createdBy: 'me',
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  ...over,
})

describe('columnOf', () => {
  it.each<[StreamStatus, string]>([
    ['idea', 'inbox'],
    ['shaping', 'inbox'],
    ['queued', 'queued'],
    ['paused', 'queued'],
    ['running', 'active'],
    ['watching', 'active'],
    ['needs_review', 'needs_you'],
    ['question', 'needs_you'],
    ['failed', 'needs_you'],
    ['interrupted', 'needs_you'],
    ['done', 'done'],
    ['skipped', 'done'],
  ])('%s lands in %s', (status, column) => expect(columnOf(status)).toBe(column))
})

describe('sortColumn', () => {
  const ids = (xs: StreamItem[]) => xs.map((x) => x.id)

  it('puts dragged cards first, in their rank order', () => {
    const xs = [
      item({ id: 'u', status: 'queued' }),
      item({ id: 'r2', status: 'queued', sortOrder: 20 }),
      item({ id: 'r1', status: 'queued', sortOrder: 10 }),
    ]
    expect(ids(sortColumn(xs, 'queued'))).toEqual(['r1', 'r2', 'u'])
  })

  it('keeps unranked queued cards in dump order (oldest first)', () => {
    const xs = [
      item({ id: 'new', status: 'queued', createdAt: '2026-09-30T12:00:00.000Z' }),
      item({ id: 'old', status: 'queued', createdAt: '2026-09-30T09:00:00.000Z' }),
    ]
    expect(ids(sortColumn(xs, 'queued'))).toEqual(['old', 'new'])
  })

  it('keeps the inbox in dump order, so a split dump reads 1, 2, 3', () => {
    const xs = [
      item({ id: 'card-2', createdAt: '2026-09-30T09:00:00.001Z' }),
      item({ id: 'card-1', createdAt: '2026-09-30T09:00:00.000Z' }),
    ]
    expect(ids(sortColumn(xs, 'inbox'))).toEqual(['card-1', 'card-2'])
  })

  it('ranks unranked needs-you cards by priority, then the longest wait', () => {
    const xs = [
      item({ id: 'low', status: 'needs_review', priority: 'low', updatedAt: '2026-09-30T08:00:00.000Z' }),
      item({ id: 'none', status: 'needs_review', updatedAt: '2026-09-30T09:00:00.000Z' }),
      item({ id: 'urgent', status: 'failed', priority: 'urgent', updatedAt: '2026-09-30T11:00:00.000Z' }),
      item({ id: 'normal', status: 'question', priority: 'normal', updatedAt: '2026-09-30T08:30:00.000Z' }),
    ]
    expect(ids(sortColumn(xs, 'needs_you'))).toEqual(['urgent', 'normal', 'none', 'low'])
  })

  it('lets my drag beat an urgent rating', () => {
    const xs = [
      item({ id: 'urgent', status: 'needs_review', priority: 'urgent' }),
      item({ id: 'mine', status: 'needs_review', priority: 'low', sortOrder: 10 }),
    ]
    expect(ids(sortColumn(xs, 'needs_you'))).toEqual(['mine', 'urgent'])
  })

  it('shows the most recently finished first in done', () => {
    const xs = [
      item({ id: 'old', status: 'done', updatedAt: '2026-09-30T09:00:00.000Z' }),
      item({ id: 'new', status: 'skipped', updatedAt: '2026-09-30T12:00:00.000Z' }),
    ]
    expect(ids(sortColumn(xs, 'done'))).toEqual(['new', 'old'])
  })

  it('only keeps the cards of that column', () => {
    const xs = [item({ id: 'q', status: 'queued' }), item({ id: 'i', status: 'idea' })]
    expect(ids(sortColumn(xs, 'queued'))).toEqual(['q'])
  })
})

describe('dropStatus', () => {
  it('reorders within the same column without a status change', () => {
    expect(dropStatus('paused', 'queued')).toBe('paused')
    expect(dropStatus('failed', 'needs_you')).toBe('failed')
  })

  it('queues an idea dropped on Queued, and sends a queued card back to the inbox', () => {
    expect(dropStatus('idea', 'queued')).toBe('queued')
    expect(dropStatus('queued', 'inbox')).toBe('idea')
    expect(dropStatus('paused', 'inbox')).toBe('idea')
  })

  it('skips a queued card dropped on Done', () => {
    expect(dropStatus('queued', 'done')).toBe('skipped')
  })

  it('snaps back anything else', () => {
    expect(dropStatus('idea', 'active')).toBeNull()
    expect(dropStatus('queued', 'needs_you')).toBeNull()
    expect(dropStatus('running', 'done')).toBeNull()
    expect(dropStatus('done', 'queued')).toBeNull()
    expect(dropStatus('shaping', 'queued')).toBeNull()
  })
})

describe('streamActions', () => {
  const actionIds = (over: Partial<StreamItem>) => streamActions(item(over)).map((a) => a.id)

  it('offers queue, skip and remove on an idea', () => {
    expect(actionIds({ status: 'idea' })).toEqual(['queue', 'skip', 'top', 'bottom', 'remove'])
  })

  it('offers run now, pause and back-to-inbox on a queued card', () => {
    expect(actionIds({ status: 'queued' })).toEqual([
      'run',
      'pause',
      'to-inbox',
      'done',
      'skip',
      'top',
      'bottom',
      'remove',
    ])
  })

  it('offers approve on a card waiting for my review', () => {
    expect(actionIds({ status: 'needs_review' })).toEqual(['approve', 'skip', 'top', 'bottom', 'remove'])
  })

  it('offers retry on a failed or interrupted card', () => {
    expect(actionIds({ status: 'failed' })[0]).toBe('retry')
    expect(actionIds({ status: 'interrupted' })[0]).toBe('retry')
  })

  it('offers resume on a paused card', () => {
    expect(actionIds({ status: 'paused' })[0]).toBe('resume')
  })

  it('offers re-queue on a finished card', () => {
    expect(actionIds({ status: 'done' })).toEqual(['requeue', 'top', 'bottom', 'remove'])
  })

  it('offers reset priority only once the card has a rank', () => {
    expect(actionIds({ status: 'queued', sortOrder: 10 })).toContain('reset-priority')
    expect(actionIds({ status: 'queued' })).not.toContain('reset-priority')
  })

  it('offers nothing on a running card (cancel lives on the run)', () => {
    expect(actionIds({ status: 'running' })).toEqual([])
  })
})

describe('applyStreamAction', () => {
  it('maps status actions to their status', () => {
    expect(applyStreamAction('idea', 'queue')).toBe('queued')
    expect(applyStreamAction('queued', 'pause')).toBe('paused')
    expect(applyStreamAction('paused', 'resume')).toBe('queued')
    expect(applyStreamAction('queued', 'to-inbox')).toBe('idea')
    expect(applyStreamAction('failed', 'done')).toBe('done')
    expect(applyStreamAction('queued', 'skip')).toBe('skipped')
    expect(applyStreamAction('skipped', 'requeue')).toBe('queued')
  })

  it('approving a result finishes the card', () => expect(applyStreamAction('needs_review', 'approve')).toBe('done'))

  it('leaves run and retry to the runner', () => {
    expect(applyStreamAction('queued', 'run')).toBeNull()
    expect(applyStreamAction('failed', 'retry')).toBeNull()
  })

  it('leaves the status alone for ordering actions', () => {
    expect(applyStreamAction('queued', 'top')).toBeNull()
    expect(applyStreamAction('queued', 'reset-priority')).toBeNull()
  })
})

describe('movedIds', () => {
  const col = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]

  it('moves a card to the top', () => expect(movedIds(col, 'c', 'top')).toEqual(['c', 'a', 'b']))
  it('moves a card to the bottom', () => expect(movedIds(col, 'a', 'bottom')).toEqual(['b', 'c', 'a']))
})

describe('parseDump', () => {
  const titles = (text: string) => parseDump(text, REPOS, 'owner/app').map((d) => d.title)

  it('makes one item per line, dropping blanks and bullets', () => {
    expect(titles('- fix login\n\n* bump deps\n3. write docs\n')).toEqual(['fix login', 'bump deps', 'write docs'])
  })

  it('splits a list of targets into one item each', () => {
    expect(titles('implement card 1,2,3,4')).toEqual([
      'implement card 1',
      'implement card 2',
      'implement card 3',
      'implement card 4',
    ])
  })

  it('splits "and" lists and keeps the rest of the sentence on each item', () => {
    expect(titles('implement ITEM-12, ITEM-13 and ITEM-14 with tests')).toEqual([
      'implement ITEM-12 with tests',
      'implement ITEM-13 with tests',
      'implement ITEM-14 with tests',
    ])
  })

  it('keeps a list together when I say it goes in one branch', () => {
    expect(titles('implement card 1,2,3,4 in one branch')).toEqual(['implement card 1,2,3,4 in one branch'])
    expect(titles('do 1, 2 together')).toEqual(['do 1, 2 together'])
  })

  it('groups nothing when a line names a single target', () => {
    expect(titles('follow up on PR #2')).toEqual(['follow up on PR #2'])
  })

  it('reads a #number as a PR of the picked project', () => {
    expect(parseDump('follow up on PR #2', REPOS, 'owner/app')[0]).toMatchObject({ refKind: 'pr', ref: 'owner/app#2' })
  })

  it('reads a GitHub PR URL as that PR, whatever the picked project', () => {
    expect(parseDump('review https://github.com/acme/api/pull/57 please', REPOS, 'owner/app')[0]).toMatchObject({
      refKind: 'pr',
      ref: 'acme/api#57',
    })
  })

  it('keeps any other URL as a plain reference', () => {
    expect(parseDump('implement https://www.notion.so/acme/Card-123abc', REPOS, 'owner/app')[0]).toMatchObject({
      refKind: 'url',
      ref: 'https://www.notion.so/acme/Card-123abc',
    })
  })

  it('gives each split item its own PR reference', () => {
    expect(parseDump('follow up on #2 and #3', REPOS, 'owner/app').map((d) => d.ref)).toEqual([
      'owner/app#2',
      'owner/app#3',
    ])
  })

  it('has no reference for plain text', () => {
    expect(parseDump('bump deps', REPOS, 'owner/app')[0]).toMatchObject({ refKind: null, ref: null })
  })

  it.each([
    'limit export to 1,000 rows',
    'upgrade deps to 1.2, 1.3',
    'release on Sept 3, 2026',
    'handle values between 1 and 10',
  ])('leaves numbers that are not a list of targets alone: %s', (line) => expect(titles(line)).toEqual([line]))

  it('splits a list after any work noun', () => {
    expect(titles('fix bugs 3 and 4')).toEqual(['fix bugs 3', 'fix bugs 4'])
    expect(titles('close issues 7, 8')).toEqual(['close issues 7', 'close issues 8'])
  })

  it('never splits inside a URL', () => {
    expect(titles('follow up on https://github.com/o/r/pull/2 and #3')).toEqual([
      'follow up on https://github.com/o/r/pull/2 and #3',
    ])
  })

  it('drops trailing punctuation from a URL reference', () => {
    expect(parseDump('see https://notion.so/Page-123, then ship', REPOS, 'owner/app')[0].ref).toBe(
      'https://notion.so/Page-123',
    )
    expect(parseDump('spec (https://notion.so/Spec).', REPOS, 'owner/app')[0].ref).toBe('https://notion.so/Spec')
  })
})

describe('parseDump projects', () => {
  const dump = (text: string, picked: string | null = null) =>
    parseDump(text, REPOS, picked).map((d) => ({ title: d.title, repo: d.repo }))

  it('files the line under the picked project', () => {
    expect(dump('bump deps', 'acme/api')).toEqual([{ title: 'bump deps', repo: 'acme/api' }])
  })

  it('leaves the project open with All projects and no hint', () => {
    expect(dump('bump deps')).toEqual([{ title: 'bump deps', repo: null }])
  })

  it('reads a #project tag, drops it from the title, and applies it to every split item', () => {
    expect(dump('#app implement card 1,2')).toEqual([
      { title: 'implement card 1', repo: 'owner/app' },
      { title: 'implement card 2', repo: 'owner/app' },
    ])
  })

  it('lets a line tag win over the picked project', () => {
    expect(dump('fix login #api', 'owner/app')).toEqual([{ title: 'fix login', repo: 'acme/api' }])
  })

  it('matches a full owner/repo tag and ignores case', () => {
    expect(dump('#Acme/API bump deps')).toEqual([{ title: 'bump deps', repo: 'acme/api' }])
    expect(dump('#APP bump deps')).toEqual([{ title: 'bump deps', repo: 'owner/app' }])
  })

  it('makes a tag alone on its line the project of the lines after it', () => {
    expect(dump('#api\nbump deps\nfix login\n#app\nwrite docs')).toEqual([
      { title: 'bump deps', repo: 'acme/api' },
      { title: 'fix login', repo: 'acme/api' },
      { title: 'write docs', repo: 'owner/app' },
    ])
  })

  it('keeps an unknown #word in the title', () => {
    expect(dump('fix the #hotfix flow')).toEqual([{ title: 'fix the #hotfix flow', repo: null }])
  })

  it('never reads #2 as a project', () => {
    expect(parseDump('follow up on #2', REPOS, 'owner/app')[0]).toMatchObject({ repo: 'owner/app', ref: 'owner/app#2' })
  })

  it('takes the project from a watched PR link when nothing else says', () => {
    expect(dump('review https://github.com/acme/api/pull/57')).toEqual([
      { title: 'review https://github.com/acme/api/pull/57', repo: 'acme/api' },
    ])
  })

  it('has no PR reference for a bare #2 until the project is known', () => {
    expect(parseDump('follow up on #2', REPOS, null)[0]).toMatchObject({ repo: null, refKind: null, ref: null })
  })

  it('matches nothing on a short name two projects share', () => {
    expect(parseDump('#app bump', [...REPOS, 'other/app'], null)[0]).toMatchObject({ repo: null })
  })
})

describe('dumpRef', () => {
  it('resolves a bare #2 once the project is known', () => {
    expect(dumpRef('follow up on #2', 'acme/api')).toEqual({ refKind: 'pr', ref: 'acme/api#2' })
  })
})

describe('projectGate', () => {
  it('encodes where an item goes once I name its project', () => {
    expect(projectGateTarget(projectGate('queued'))).toBe('queued')
    expect(projectGateTarget(projectGate('idea'))).toBe('idea')
  })

  it('is null for any other gate', () => {
    expect(projectGateTarget('result')).toBeNull()
    expect(projectGateTarget(null)).toBeNull()
  })
})

describe('entryRank', () => {
  it('puts a card entering Done on top of the cards I placed there', () => {
    const xs = [item({ id: 'd1', status: 'done', sortOrder: 10 }), item({ id: 'd2', status: 'skipped', sortOrder: 20 })]
    expect(entryRank(xs, 'done')).toBe(0)
  })

  it('leaves it unranked when nothing in Done is ranked (the default order already puts it first)', () => {
    expect(entryRank([item({ status: 'done' })], 'done')).toBeNull()
  })

  it('leaves it unranked everywhere else: bottom of Inbox/Queued, criticality in Needs you', () => {
    const xs = [item({ status: 'queued', sortOrder: 10 }), item({ status: 'idea', sortOrder: 10 })]
    expect(entryRank(xs, 'queued')).toBeNull()
    expect(entryRank(xs, 'idea')).toBeNull()
    expect(entryRank(xs, 'needs_review')).toBeNull()
  })
})

describe('isNoMove', () => {
  const col = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]

  it('is a no-op dropped on itself, just below itself, or at the end while last', () => {
    expect(isNoMove(col, 'a', 'a')).toBe(true)
    expect(isNoMove(col, 'a', 'b')).toBe(true)
    expect(isNoMove(col, 'c', null)).toBe(true)
  })

  it('is a move anywhere else, or from another column', () => {
    expect(isNoMove(col, 'c', 'a')).toBe(false)
    expect(isNoMove(col, 'a', null)).toBe(false)
    expect(isNoMove(col, 'x', 'a')).toBe(false)
  })
})
