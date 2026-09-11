import { describe, expect, it } from 'vitest'
import { startOfToday } from './time'

describe('startOfToday', () => {
  it('is local midnight of the given day, not UTC midnight', () => {
    const noon = new Date(2026, 8, 11, 12, 0, 0)
    const midnight = new Date(startOfToday(noon))
    expect(midnight.getFullYear()).toBe(2026)
    expect(midnight.getMonth()).toBe(8)
    expect(midnight.getDate()).toBe(11)
    expect(midnight.getHours()).toBe(0)
    expect(midnight.getMinutes()).toBe(0)
  })

  it('keeps a late-evening merge inside the current day', () => {
    const late = new Date(2026, 8, 11, 23, 50, 0)
    expect(new Date(startOfToday(late)) <= late).toBe(true)
    expect(startOfToday(late)).toBe(startOfToday(new Date(2026, 8, 11, 0, 10, 0)))
  })

  it('rolls over at midnight', () =>
    expect(startOfToday(new Date(2026, 8, 12, 0, 1, 0))).not.toBe(startOfToday(new Date(2026, 8, 11, 23, 59, 0))))
})
