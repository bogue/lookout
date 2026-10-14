-- What Lookout did on a card by itself, for the card's history. For now: the merge action
-- (src/lib/mergehook.ts) — the prompt it sent to Claude right after I merged the PR from the
-- card's panel. A prompt's session is listed here because nothing else ties it to
-- the card: it runs in the clone and its prompt need not name the branch.
CREATE TABLE IF NOT EXISTS card_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,      -- owner/repo#number
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,         -- merge_prompt
  text TEXT NOT NULL,         -- the filled prompt
  session_id TEXT,            -- the claude session a prompt started
  status TEXT NOT NULL,       -- running | ok | failed
  output TEXT                 -- why it failed
);

CREATE INDEX IF NOT EXISTS card_events_task ON card_events (task_id);
