// The quick actions a card offers. One list, shown by the panel's ⋯ menu, a card's hover ⋯ and a
// right-click on the card, so all three always agree on what can be done from where.
export type CardActionId = 'snooze' | 'resume' | 'open-browser' | 'remove' | 'kill'

export type CardAction = { id: CardActionId; label: string; title?: string; danger?: boolean }

export type CardActionContext = {
  snoozed: boolean
  hasSession: boolean // a Claude session to resume
  isPr: boolean // a card from the Pull Requests board (my own PR)
  running: boolean // a run is in flight
}

// also shown on its own, as the PR panel's snooze button
export const snoozeAction = (snoozed: boolean): CardAction =>
  snoozed
    ? { id: 'snooze', label: 'Unsnooze', title: 'Show this card on the board again' }
    : { id: 'snooze', label: 'Snooze', title: "Hide this card until there's new activity on the PR" }

export const cardActions = (c: CardActionContext): CardAction[] => [
  snoozeAction(c.snoozed),
  ...(c.hasSession ? [{ id: 'resume', label: 'Resume session in Ghostty' } as const] : []),
  { id: 'open-browser', label: 'Open in browser' },
  // my own PR stays on its board until it merges; only a review card can be dropped
  ...(c.isPr ? [] : [{ id: 'remove', label: 'Remove from board' } as const]),
  ...(c.running ? [{ id: 'kill', label: 'Kill run', danger: true } as const] : []),
]
