-- When I last sent the card back to Discovery ("Remove from board"); NULL = never, or boarded since.
-- Sync only re-boards a removed PR on engagement newer than this.
ALTER TABLE tasks ADD COLUMN removed_at TEXT;
