import type { CiChecks } from '../types'

// A red build, with how much of it is red: "✗ CI 4/7" (failed / all checks). Bare ✗ until a sync
// has counted the checks. Clicking it opens the card with the failing checks unfolded.
export const CiFailBadge = ({ checks, onOpen }: { checks: CiChecks; onOpen?: () => void }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation()
      onOpen?.()
    }}
    className="cursor-pointer rounded bg-red-500/20 px-1 py-0.5 text-red-300 hover:bg-red-500/40"
    title={`${checks ? `${checks.failed} of ${checks.total} checks failed` : 'CI failed'} — click to see them`}
  >
    ✗ CI{checks && ` ${checks.failed}/${checks.total}`}
  </button>
)

// Checks exist but none really ran: all neutral (a bot with nothing to say) or skipped
export const CiNeutralBadge = () => (
  <span
    className="rounded bg-deck-700 px-1 py-0.5 text-deck-400"
    title="Only neutral or skipped checks — no CI actually ran"
  >
    ~ CI
  </span>
)

// GitHub can't merge the branch as it stands. Only shown when the PR has no CI state at all: that
// is usually why nothing ran (pull-request CI doesn't start on a conflicting branch).
export const ConflictsBadge = () => (
  <span
    className="rounded bg-orange-500/20 px-1 py-0.5 text-orange-300"
    title="Merge conflicts with the base branch — CI can't run until they're resolved"
  >
    ✗ Conflicts
  </span>
)
