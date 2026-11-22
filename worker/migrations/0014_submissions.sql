-- Project submissions, made on the site from the records it holds (see
-- src/submissions.ts). Only witnessed time is credited, less what earlier
-- submissions of the project covered; a neoadmin may accept unwitnessed time
-- by hand, with a note. The stretches of time and the day files they came
-- from are in R2, at snapshot_key. imported marks a submission copied from
-- the old review server, with the credit it had there.
CREATE TABLE submissions (
	id TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	project_key TEXT NOT NULL,
	project_name TEXT NOT NULL,
	received_at INTEGER NOT NULL,
	witnessed_seconds INTEGER NOT NULL,
	unwitnessed_seconds INTEGER NOT NULL,
	earlier_overlap_seconds INTEGER NOT NULL,
	credited_seconds INTEGER NOT NULL,
	accepted_seconds INTEGER NOT NULL DEFAULT 0,
	prompts INTEGER NOT NULL,
	tokens_in INTEGER NOT NULL DEFAULT 0,
	tokens_out INTEGER NOT NULL DEFAULT 0,
	state TEXT NOT NULL DEFAULT 'pending',
	decided_by TEXT,
	decided_at INTEGER,
	note TEXT,
	snapshot_key TEXT NOT NULL,
	imported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX submissions_user_project ON submissions (user_id, project_key);
CREATE INDEX submissions_state ON submissions (state, received_at);
