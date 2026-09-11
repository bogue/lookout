import { load } from '@tauri-apps/plugin-store'
import type { PrColumn } from '../types'

// Retired store. Manual placements and drag positions used to live in `pr-overrides.json` because the
// PR board had no table of its own; both now live in `my_prs` (migration 013).
//
// The mechanism is gone — an override was a pin against a baseline, dropped as soon as the derived
// column moved for any reason, which is what made cards jump. But the placements themselves are real
// user intent, so they are carried across once as the starting `board_column` and the file is emptied.
export type LegacyPrStore = { columns: Record<string, PrColumn>; orders: Record<string, number> }

const COLUMNS: PrColumn[] = ['waiting', 'in_review', 'ready', 'done']
const isColumn = (v: unknown): v is PrColumn => typeof v === 'string' && COLUMNS.includes(v as PrColumn)

export const migrateLegacyPrStore = async (): Promise<LegacyPrStore> => {
  const store = await load('pr-overrides.json').catch(() => null)
  if (!store) return { columns: {}, orders: {} }

  const columns: Record<string, PrColumn> = {}
  const rawColumns = (await store.get<Record<string, unknown>>('overrides')) ?? {}
  for (const [id, v] of Object.entries(rawColumns)) {
    // two shapes ever existed: {column, baseline}, and a bare column string before baselines landed
    const column = isColumn(v)
      ? v
      : isColumn((v as { column?: unknown } | null)?.column)
        ? (v as { column: PrColumn }).column
        : null
    if (column) columns[id] = column
  }

  const orders: Record<string, number> = {}
  const rawOrders = (await store.get<Record<string, unknown>>('order')) ?? {}
  for (const [id, v] of Object.entries(rawOrders)) if (typeof v === 'number') orders[id] = v

  await store.delete('overrides')
  await store.delete('order')
  await store.save()
  return { columns, orders }
}
