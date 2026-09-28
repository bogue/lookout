import { Command } from '@tauri-apps/plugin-shell'
import { useState } from 'react'
import { PrLink } from '../components/PrLink'
import type { ReviewTask } from '../types'

type Props = { tasks: ReviewTask[] }

const openInVsCode = (path: string) => Command.create('code', [path]).spawn()

// Collapsed by default: a long list of past reviews at the bottom of Settings, opened on demand.
export const History = ({ tasks }: Props) => {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const q = query.toLowerCase()
  const past = tasks.filter((t) => t.stage === 'done' || t.reviewFiles.length > 0)
  const items = past
    .filter((t) => !q || `${t.prTitle} ${t.repo} ${t.branch} ${t.prAuthor}`.toLowerCase().includes(q))
    .sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex cursor-pointer items-center gap-2 text-left text-lg font-semibold text-deck-200 hover:text-white"
        >
          <span className={`text-sm text-deck-500 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
            ▶
          </span>
          History
          <span className="text-sm font-normal text-deck-500">({past.length})</span>
        </button>
        {open && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search title, repo, branch, author…"
            className="w-72 rounded border border-deck-600 bg-deck-800 px-2 py-1.5 text-sm outline-none focus:border-grass-500"
          />
        )}
      </div>

      {open && items.length === 0 && (
        <p className="text-sm text-deck-500">{past.length === 0 ? 'No past reviews yet.' : 'Nothing matches.'}</p>
      )}

      <ul className={`flex flex-col gap-2 ${open ? '' : 'hidden'}`}>
        {items.map((t) => (
          <li key={t.id} className="rounded-lg border border-deck-800 bg-deck-800/40 p-3">
            <div className="flex items-center gap-2">
              <PrLink
                url={t.prUrl}
                repo={t.repo}
                prNumber={t.prNumber}
                className="min-w-0 flex-1 truncate text-sm font-medium"
              >
                {t.prTitle}
              </PrLink>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  t.prState === 'merged'
                    ? 'bg-purple-500/20 text-purple-300'
                    : t.prState === 'closed'
                      ? 'bg-red-500/20 text-red-300'
                      : 'bg-grass-500/20 text-grass-300'
                }`}
              >
                {t.prState}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-deck-500">
              <span>
                {t.repo}#{t.prNumber}
              </span>
              <span className="font-mono">{t.branch}</span>
              <span>by {t.prAuthor}</span>
              {t.doneAt && <span>done {new Date(t.doneAt).toLocaleDateString()}</span>}
            </div>
            {t.reviewFiles.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {t.reviewFiles.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => openInVsCode(f)}
                    title={f}
                    className="cursor-pointer self-start truncate font-mono text-xs text-grass-400 hover:underline"
                  >
                    {f.split('/').at(-1)} ↗
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
