-- The latest verdict other humans gave a PR I review (approved / changes_requested / commented);
-- NULL = none yet. Mine and bots' are left out. Drives the Discovery "Reviews" filter.
ALTER TABLE tasks ADD COLUMN others_review TEXT;
