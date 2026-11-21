-- Times are Unix milliseconds.

-- When the person deleted their account; NULL for an account in use. A deleted
-- account keeps its row and its log, so deleting it doesn't hide what it sent
-- from reviewers. Signing in again reopens it.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;

-- What the latest report of a computer covers, kept beside it so the next
-- report can be compared with it without reading the whole report again.
ALTER TABLE computers ADD COLUMN since TEXT NOT NULL DEFAULT ''; -- the report's window, such as 365d
ALTER TABLE computers ADD COLUMN days TEXT NOT NULL DEFAULT ''; -- JSON: engaged seconds by date

-- For reviewers: every report a person's computers sent, stored or refused,
-- every computer they removed, and each time they deleted their account. Rows
-- are added and never changed; the oldest of a person's rows are dropped once
-- they have too many.
CREATE TABLE account_log (
	id INTEGER PRIMARY KEY,
	-- The site never deletes a users row. An operator who must erase a person
	-- for good deletes theirs by hand, and the log goes with it.
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	at INTEGER NOT NULL, -- by this server's clock
	event TEXT NOT NULL, -- 'sync' (from the CLI), 'upload' (a stats file), 'remove' (a computer), or 'delete' (the account)
	computer_id TEXT NOT NULL DEFAULT '', -- '' for 'delete', and for a report refused before it said whose it was
	refusal TEXT NOT NULL DEFAULT '', -- why a report was refused; '' for one that was stored
	flagged INTEGER NOT NULL DEFAULT 0, -- 1 when the server found something a reviewer should see
	-- What the report said about itself. For 'remove', the computer's last
	-- report. For 'delete', engaged_seconds is the total of the account's computers.
	generated_at INTEGER, -- by the computer's clock
	teardrop_version TEXT NOT NULL DEFAULT '',
	since TEXT NOT NULL DEFAULT '',
	engaged_seconds INTEGER NOT NULL DEFAULT 0,
	-- The report of the same computer that a stored report replaced. NULL for a
	-- computer's first report.
	prev_generated_at INTEGER,
	prev_since TEXT,
	prev_engaged_seconds INTEGER,
	prev_teardrop_version TEXT,
	-- Time the report added to days that were over when the one before it was
	-- made. NULL when the two could not be compared day by day.
	past_added_seconds INTEGER
);

CREATE INDEX account_log_user ON account_log (user_id, id);
CREATE INDEX account_log_flagged ON account_log (user_id, flagged, id);
