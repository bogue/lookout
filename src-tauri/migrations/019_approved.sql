-- At least one human reviewer's latest review is an approval (whatever the others said). Shown as a
-- green check before the card title on both boards.
ALTER TABLE tasks ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE my_prs ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
