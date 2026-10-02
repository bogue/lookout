import { CHAT_COMMAND } from './chat'
import type { FeedEvent } from './feed'
import type { IconName } from './icons'

// A session the panel's input can talk to, for the picker under it
export type SessionOption = { sessionId: string; icon: IconName; label: string; ts?: string }

// The PR's sessions, newest first, named as the history names them (minus the "started"). A run
// that just started isn't in the history until it finishes, so it is added from the run itself.
export const sessionOptions = (
  feed: FeedEvent[] | null,
  run: { sessionId: string | null; command: string } | undefined,
): SessionOption[] => {
  const known: SessionOption[] = (feed ?? [])
    .filter((e) => e.sessionId)
    .map((e) => ({
      sessionId: e.sessionId as string,
      icon: e.icon,
      label: e.text.replace(/^started (a )?/, ''),
      ts: e.ts,
    }))
    .reverse()
  if (!run?.sessionId || known.some((o) => o.sessionId === run.sessionId)) return known
  return [
    {
      sessionId: run.sessionId,
      icon: run.command === CHAT_COMMAND ? 'comment-discussion' : 'dependabot',
      label: run.command,
    },
    ...known,
  ]
}
