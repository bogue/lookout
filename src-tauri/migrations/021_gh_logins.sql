-- Review/comment authors already classified as bot or person. gh's --json drops GitHub's Bot type, so
-- the sync asks GraphQL, but only about logins missing here: once filled, most syncs make no call, and
-- a restart or a failed lookup can't turn Cursor back into a person (that flips verdicts, wakes cards).
CREATE TABLE IF NOT EXISTS gh_logins (
  login TEXT PRIMARY KEY,
  is_bot INTEGER NOT NULL
);
