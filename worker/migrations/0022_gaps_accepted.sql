-- What a neoadmin accepted for each gap with commits, as a JSON array in the
-- snapshot's gap order, so deciding again starts from it.
ALTER TABLE submissions ADD COLUMN gaps_accepted TEXT;
