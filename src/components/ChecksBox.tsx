import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useState } from 'react'
import { type CheckItem, checkDuration } from '../lib/prboard'

const ICON: Record<CheckItem['state'], { glyph: string; className: string }> = {
  fail: { glyph: '✗', className: 'text-red-400' },
  pending: { glyph: '●', className: 'text-amber-400' },
  pass: { glyph: '✓', className: 'text-grass-400' },
  skipped: { glyph: '⊘', className: 'text-deck-500' },
}

const STATUS: Record<CheckItem['state'], string> = {
  fail: 'Failing after',
  pending: 'In progress',
  pass: 'Successful in',
  skipped: 'Skipped',
}

const Row = ({ c }: { c: CheckItem }) => (
  <li>
    <button
      type="button"
      onClick={() => c.url && openUrl(c.url)}
      disabled={!c.url}
      title={c.url ? 'Open the check on GitHub' : undefined}
      className="flex w-full cursor-pointer items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-deck-800 disabled:cursor-default"
    >
      <span className={`w-3 shrink-0 text-center ${ICON[c.state].className}`}>{ICON[c.state].glyph}</span>
      <span className="min-w-0 truncate text-deck-200">{c.name}</span>
      <span className="shrink-0 text-deck-500">
        {STATUS[c.state]}
        {(c.state === 'fail' || c.state === 'pass') && c.seconds !== null && ` ${checkDuration(c.seconds)}`}
      </span>
    </button>
  </li>
)

// A section of the list, GitHub style: "1 failing check ›", open or folded
const Group = ({ label, items, open: initial }: { label: string; items: CheckItem[]; open: boolean }) => {
  const [open, setOpen] = useState(initial)
  useEffect(() => setOpen(initial), [initial])
  if (!items.length) return null
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer px-2 py-1 text-deck-400 hover:text-deck-200"
      >
        {items.length} {label} {open ? '⌄' : '›'}
      </button>
      {open && (
        <ul>
          {items.map((c) => (
            <Row key={c.name} c={c} />
          ))}
        </ul>
      )}
    </div>
  )
}

// GitHub's merge-box checks summary, compact: one line folded, the failing checks listed once opened.
// Only shown while something fails.
export const ChecksBox = ({ checks, expanded }: { checks: CheckItem[]; expanded: boolean }) => {
  const [open, setOpen] = useState(expanded)
  useEffect(() => setOpen(expanded), [expanded])
  const by = (s: CheckItem['state']) => checks.filter((c) => c.state === s)
  const failing = by('fail')
  if (!failing.length) return null
  const ran = checks.filter((c) => c.state !== 'skipped').length
  const summary = [
    `${failing.length} failing`,
    by('pending').length && `${by('pending').length} in progress`,
    by('pass').length && `${by('pass').length} successful`,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <div className="border-t border-deck-800 px-3 pt-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${summary} checks`}
        className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left hover:bg-deck-800"
      >
        <span className="text-red-400">✗</span>
        <span className="text-deck-200">
          Merge conditions are failing ({failing.length}/{ran})
        </span>
        <span className="text-deck-500">{summary} checks</span>
        <span className="ml-auto text-deck-400">{open ? '⌄' : '›'}</span>
      </button>
      {open && (
        <div className="max-h-[30vh] overflow-y-auto pb-1 pl-5">
          <Group label={failing.length === 1 ? 'failing check' : 'failing checks'} items={failing} open />
          <Group label="in progress" items={by('pending')} open={false} />
          <Group label="successful checks" items={by('pass')} open={false} />
          <Group label="skipped" items={by('skipped')} open={false} />
        </div>
      )}
    </div>
  )
}
