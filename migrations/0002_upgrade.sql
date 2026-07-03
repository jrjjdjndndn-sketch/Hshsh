-- Upgrade: smarter checks (keyword validation, notes, failure streaks)

-- New per-link columns
ALTER TABLE links ADD COLUMN keyword TEXT;
ALTER TABLE links ADD COLUMN consecutive_fails INTEGER NOT NULL DEFAULT 0;

-- New per-check column: human-readable note (e.g. auth-redirect)
ALTER TABLE checks ADD COLUMN note TEXT;
