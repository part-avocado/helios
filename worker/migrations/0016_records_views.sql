-- Each computer's work blocks per day, worked out by the hub from its records,
-- so a computer that syncs records shows on the dashboard and in the review
-- app as one that syncs reports does. JSON: [[start, end, engaged s, prompts,
-- tokens in, tokens out, lines added, lines removed, project key, tools]].
ALTER TABLE prompt_days ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]';

-- The account log's older rows live in R2, as compressed JSON lines of whole
-- rows, at key; D1 keeps each person's newest rows and this index of the rest.
CREATE TABLE log_archives (
	user_id INTEGER NOT NULL REFERENCES users (id),
	key TEXT PRIMARY KEY,
	first_id INTEGER NOT NULL,
	last_id INTEGER NOT NULL,
	rows INTEGER NOT NULL,
	flagged INTEGER NOT NULL,
	refused INTEGER NOT NULL,
	unchecked TEXT NOT NULL, -- JSON: computer -> seconds its first reports held, which nothing could be compared with
	archived_at INTEGER NOT NULL
);
CREATE INDEX log_archives_user ON log_archives (user_id, last_id);
