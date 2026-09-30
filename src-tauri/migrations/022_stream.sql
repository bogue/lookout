-- The Stream board: things I dump, in order, for Lookout's agents to work through — "implement card
-- 1, 2, 3, 4", "follow up on PR #2" — across any watched repo (AI_TASKS/2026-09-29-stream-tab.md).
-- Unlike `tasks` and `my_prs` nothing here mirrors GitHub: an item is my own record, so the table is
-- the only truth and no sync ever rewrites it.
--
-- `status` is the item's state; the column it shows in is derived from it (src/lib/stream.ts).
-- `sort_order` is my drag rank within that column — NULL means unranked, and the column's own
-- default order applies (dump order in Queued, criticality in Needs you).
--
-- The step/run columns (steps, step_index, gate, wait_for, branch, checkout, session_ids, …) are
-- written by the dispatch phases; the manual board leaves them at their defaults.
CREATE TABLE IF NOT EXISTS stream_items (
  id TEXT PRIMARY KEY,                  -- uuid
  repo TEXT NOT NULL,                   -- owner/repo
  group_id TEXT,                        -- items sharing one branch/worktree ("in one branch")
  title TEXT NOT NULL,
  body TEXT,                            -- notes
  ref_kind TEXT,                        -- pr | url | NULL
  ref TEXT,                             -- owner/repo#2, a Notion/Jira URL…
  template_id TEXT,                     -- flow template it came from
  steps TEXT NOT NULL DEFAULT '[]',     -- JSON [{prompt, gate, waitFor}]
  guidelines TEXT,
  step_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                 -- idea|shaping|queued|paused|running|watching|needs_review|question|failed|interrupted|done|skipped
  gate TEXT,                            -- risk|plan|result when status = needs_review
  wait_for TEXT,                        -- JSON trigger + baseline when status = watching
  sort_order INTEGER,                   -- manual rank within its column; NULL = default order
  priority TEXT,                        -- urgent|high|normal|low — Needs you criticality
  priority_reason TEXT,
  priority_source TEXT,                 -- haiku | me (a priority I set is never re-rated)
  branch TEXT,
  checkout TEXT,                        -- path the runs use
  session_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT 'me', -- me | cli | watcher:<id>
  dedupe_key TEXT,                      -- set by a Watcher, e.g. owner/repo#2
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stream_items_status ON stream_items (status);

-- The audit trail: who did what to an item, shown as its feed.
CREATE TABLE IF NOT EXISTS stream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,                  -- me | lookout | github | cli | watcher:<id>
  kind TEXT NOT NULL,                   -- created | status | edited | priority | …
  step INTEGER,
  text TEXT
);

CREATE INDEX IF NOT EXISTS stream_events_item ON stream_events (item_id);
