-- Times are Unix milliseconds.

-- One row per person, created the first time they sign in with Hack Club Auth.
CREATE TABLE users (
	id INTEGER PRIMARY KEY,
	hca_id TEXT NOT NULL UNIQUE, -- Hack Club Auth's ID for this person
	slack_id TEXT NOT NULL DEFAULT '', -- admins are listed by Slack user ID
	name TEXT NOT NULL DEFAULT '',
	api_key TEXT NOT NULL UNIQUE, -- sent by `teardrop sync`; can only upload
	created_at INTEGER NOT NULL
);

-- A computer is one teardrop install, named by its signing key. It belongs to
-- the first person who syncs from it, so its hours can't count for two people.
CREATE TABLE computers (
	id TEXT PRIMARY KEY, -- td-…, derived from public_key
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	public_key TEXT NOT NULL,
	-- The rest describe the computer's latest report, stored in report_chunks.
	signature TEXT NOT NULL,
	generated_at INTEGER NOT NULL, -- when the computer signed it
	synced_at INTEGER NOT NULL, -- when it arrived
	teardrop_version TEXT NOT NULL DEFAULT '',
	engaged_seconds INTEGER NOT NULL DEFAULT 0 -- the report's total
);

CREATE INDEX computers_user ON computers (user_id);

-- The latest signed report of each computer, exactly as signed, split into
-- pieces because D1 stores at most 2 MB in one value.
CREATE TABLE report_chunks (
	computer_id TEXT NOT NULL REFERENCES computers (id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	data TEXT NOT NULL,
	PRIMARY KEY (computer_id, seq)
);
