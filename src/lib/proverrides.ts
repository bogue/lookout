import { load } from '@tauri-apps/plugin-store'

// Retired store. Manual placements and drag positions used to live in `pr-overrides.json` because
// the PR board had no table of its own; both now live in `my_prs` (migration 013).
//
// The `overrides` half is gone for good — it held a self-healing pin that was dropped as soon as
// GitHub's derived column moved for any reason, which is the behaviour that made cards jump. The
// `order` half is real user intent, so it gets carried across once and the file is then emptied.
export const migrateLegacyPrStore = async (): Promise<Record<string, number>> => {
  const store = await load('pr-overrides.json').catch(() => null)
  if (!store) return {}
  const raw = (await store.get<Record<string, unknown>>('order')) ?? {}
  const orders: Record<string, number> = {}
  for (const [id, v] of Object.entries(raw)) if (typeof v === 'number') orders[id] = v
  await store.delete('order')
  await store.delete('overrides')
  await store.save()
  return orders
}
