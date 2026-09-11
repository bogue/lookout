import type { PrColumn } from '../types'

// How far along the merge pipeline each column sits. Mirrors RANK in stages.ts — the Reviews board
// has always been forward-only, the PR board was the one still re-deriving from scratch every sync.
const RANK: Record<PrColumn, number> = { waiting: 0, in_review: 1, ready: 2, done: 3 }

// Column moves driven by GitHub are forward-only: a card that reached In Review stays there when the
// review that put it there stops counting (re-requesting a review suppresses it, toggling draft hides
// it), because having been reviewed is a fact no later state should undo.
export const advanceColumn = (current: PrColumn, target: PrColumn): PrColumn =>
  RANK[target] > RANK[current] ? target : current

// Where a card lands this sync.
//
// `derived` is what classifyColumn says right now; `lastDerived` is what it said last time. The
// placement only moves when those differ — GitHub actually changed its mind. When they agree, the
// stored placement is left exactly as it is, which is what makes a manual drag stick: dropping a card
// into a lower column persists it without touching `lastDerived`, so the next sync sees no change and
// leaves it alone. Drag freely; only a real new event can lift a card back up.
export const resolveColumn = (stored: PrColumn, lastDerived: PrColumn, derived: PrColumn): PrColumn =>
  derived === lastDerived ? stored : advanceColumn(stored, derived)
