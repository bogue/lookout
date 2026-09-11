-- The Pull Requests board (PRs I authored) was derived live on every sync and never stored, so the
-- board was empty until the first sync answered — ~28 s after launch, because `refresh()` awaits the
-- Reviews sync first — and a single repo whose `gh` call failed silently emptied its cards for that
-- pass. This table is the board's own state: the last known GitHub facts, plus the placement.
--
-- `board_column` is the effective column and is a high-water mark, not a fresh derivation:
-- `derived_column` records what classifyColumn last said, and a placement only moves when that
-- verdict actually changes (src/lib/prcolumns.ts). That is what keeps a card In Review after a
-- re-requested review suppresses the review that put it there, and what makes a manual drag stick.
CREATE TABLE IF NOT EXISTS my_prs (
  id TEXT PRIMARY KEY,                  -- owner/repo#number
  repo TEXT NOT NULL,                   -- owner/repo
  repo_path TEXT,                       -- local clone path
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  pr_created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',   -- open | merged | closed
  is_draft INTEGER NOT NULL DEFAULT 0,
  human_review TEXT,                    -- approved | changes_requested | commented | NULL
  bot_review TEXT,                      -- same, from bots; shown as a badge, never moves the column
  ci_state TEXT,                        -- pass | fail | pending | NULL
  derived_column TEXT NOT NULL,         -- what classifyColumn last returned (the change detector)
  board_column TEXT NOT NULL,           -- effective placement ("column" is a SQL keyword)
  sort_order INTEGER,                   -- manual drag position within a column
  done_at TEXT,                         -- mergedAt / closedAt; Done keeps only the current day
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS my_prs_repo ON my_prs (repo);
