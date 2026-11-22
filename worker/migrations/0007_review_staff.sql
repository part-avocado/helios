-- Times are Unix milliseconds.

-- Who may use the review app, by Slack ID. Superadmins are not listed here:
-- they are the Slack IDs in the ADMINS variable. A person can be listed
-- before they first sign in.
CREATE TABLE reviewers (
	slack_id TEXT PRIMARY KEY,
	level INTEGER NOT NULL, -- 1 for a neoadmin, 2 for a reviewer
	note TEXT NOT NULL DEFAULT '', -- why they were added, for the others
	added_by TEXT NOT NULL, -- Slack ID
	added_at INTEGER NOT NULL
);

-- Keys that reviewers make to call the review API from their own tools. A key
-- can do what the person who made it can do at the moment it is used, so it
-- stops working when they are removed or banned.
CREATE TABLE review_keys (
	id INTEGER PRIMARY KEY,
	slack_id TEXT NOT NULL, -- who made it
	name TEXT NOT NULL,
	hash TEXT NOT NULL UNIQUE, -- SHA-256 of the key, which is shown once and not kept
	hint TEXT NOT NULL, -- how the key starts, to tell one from another
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);

CREATE INDEX review_keys_owner ON review_keys (slack_id);

-- Bans, by Slack ID, so a person can be banned before they first sign in.
-- Rows are kept after a ban ends, as its history. At most one of a person's
-- bans is in force: a new ban ends the one before it.
CREATE TABLE bans (
	id INTEGER PRIMARY KEY,
	slack_id TEXT NOT NULL,
	reason TEXT NOT NULL, -- shown to the person
	by_slack_id TEXT NOT NULL,
	by_level INTEGER NOT NULL, -- the issuer's level then; someone below it can't lift the ban
	at INTEGER NOT NULL,
	until INTEGER, -- NULL for a ban that lasts until it is lifted
	lifted_at INTEGER,
	lifted_by TEXT -- Slack ID
);

CREATE INDEX bans_person ON bans (slack_id, id);

-- Who changed the team or banned someone, and when. Rows are only added.
CREATE TABLE staff_log (
	id INTEGER PRIMARY KEY,
	at INTEGER NOT NULL,
	by_slack_id TEXT NOT NULL,
	action TEXT NOT NULL, -- 'add', 'change', 'remove', 'ban', or 'unban'
	slack_id TEXT NOT NULL, -- whom it was done to
	detail TEXT NOT NULL DEFAULT ''
);
