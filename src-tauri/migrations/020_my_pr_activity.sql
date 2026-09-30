-- Human comments + reviews on my PR that aren't mine: a rise wakes a snoozed card, even when the
-- review verdict (another "commented") didn't change. NULL until the first fetch sets a baseline.
ALTER TABLE my_prs ADD COLUMN activity_count INTEGER;
