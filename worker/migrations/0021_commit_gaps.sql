-- Time a neoadmin accepted, when approving, for gaps between a
-- submission's credited stretches that hold commits GitHub has.
ALTER TABLE submissions ADD COLUMN gap_seconds INTEGER NOT NULL DEFAULT 0;
