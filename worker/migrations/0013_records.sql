-- Per-prompt records. Every prompt and turn end a harness reports is kept in
-- R2, one compressed file per person per day ({user}/prompts/YYYY/MM-DD.ndjson.gz),
-- for good. D1 keeps only each day's totals, worked out by the site from the
-- records, per computer and per person (computer_id ''), where time on two
-- computers at once counts once. Times are Unix milliseconds.
CREATE TABLE prompt_days (
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	computer_id TEXT NOT NULL,
	day TEXT NOT NULL, -- YYYY-MM-DD on the computer's clock
	-- Engaged time whose records reached the site within 5 minutes of the
	-- time they claim, and the rest.
	witnessed_seconds INTEGER NOT NULL,
	unwitnessed_seconds INTEGER NOT NULL,
	prompts INTEGER NOT NULL,
	tokens_in INTEGER NOT NULL,
	tokens_out INTEGER NOT NULL,
	lines_added INTEGER NOT NULL,
	lines_removed INTEGER NOT NULL,
	projects TEXT NOT NULL, -- JSON: project key -> [witnessed s, unwitnessed s, prompts]
	sha256 TEXT NOT NULL, -- of the day's file in R2, on the person's row
	rules INTEGER NOT NULL, -- the version of the rules that worked it out
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, computer_id, day)
);

-- Each computer's latest report lives in R2 under this name. report_chunks
-- is no longer written, and is read only for computers that haven't synced since.
ALTER TABLE computers ADD COLUMN report_key TEXT;
