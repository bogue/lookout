export const timeAgo = (iso: string | null): string => {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

// Local midnight, as an ISO instant. What "today" means for the Done column: a PR merged at 23:50
// is still today's until the clock rolls over, wherever the laptop happens to be.
export const startOfToday = (now = new Date()): string =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
