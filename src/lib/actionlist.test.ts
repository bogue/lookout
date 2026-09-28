import { describe, expect, it } from 'vitest'
import type { ActionButton } from '../types'
import { appendToken, dropAction, rulesLabel } from './actionlist'

const btn = (id: string): ActionButton => ({ id, label: id, prompt: '', conditions: [] })

describe('rulesLabel', () => {
  it('says always when there is no rule', () => expect(rulesLabel([])).toBe('Always'))
  it('counts one rule', () => expect(rulesLabel([{ field: 'stage', values: ['watching'] }])).toBe('1 rule'))
  it('counts several', () =>
    expect(
      rulesLabel([
        { field: 'stage', values: [] },
        { field: 'ciState', values: [] },
      ]),
    ).toBe('2 rules'))
})

describe('dropAction', () => {
  const list = [btn('a'), btn('b'), btn('c')]
  const ids = (l: ActionButton[]) => l.map((b) => b.id)
  it('drops an action before another — on top makes it the primary', () =>
    expect(ids(dropAction(list, 'c', 'a'))).toEqual(['c', 'a', 'b']))
  it('drops at the end when there is nothing after', () =>
    expect(ids(dropAction(list, 'a', null))).toEqual(['b', 'c', 'a']))
  it('moves down past the next one', () => expect(ids(dropAction(list, 'a', 'c'))).toEqual(['b', 'a', 'c']))
  it('leaves the list alone when dropped where it already is', () => {
    expect(dropAction(list, 'b', 'b')).toBe(list)
    expect(dropAction(list, 'b', 'c')).toBe(list)
  })
})

describe('appendToken', () => {
  it('adds the placeholder after a space', () =>
    expect(appendToken('/do-review', '<pr_id>')).toBe('/do-review <pr_id>'))
  it('does not double a trailing space', () => expect(appendToken('/do-review ', '<pr_id>')).toBe('/do-review <pr_id>'))
  it('starts an empty prompt with it', () => expect(appendToken('', '<branch_name>')).toBe('<branch_name>'))
})
