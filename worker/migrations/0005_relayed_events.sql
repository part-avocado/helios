-- Times are Unix milliseconds.

-- Events from Amp threads that ran in Amp's cloud, where the person has no
-- computer to count them on. The cloud plugin sends them with the person's
-- sync key, and they wait here until one of the person's computers takes them
-- into its own journal. AUTOINCREMENT keeps ids rising after rows are deleted,
-- because a computer remembers the last id it took.
CREATE TABLE relayed_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	received_at INTEGER NOT NULL,
	-- What makes an event itself, so one sent twice is kept once.
	session TEXT NOT NULL,
	t TEXT NOT NULL, -- when it happened, as the plugin wrote it
	event TEXT NOT NULL,
	line TEXT NOT NULL, -- the journal line, as it was sent
	UNIQUE (user_id, session, t, event)
);

-- The one computer that takes a person's cloud events, and when it last asked.
-- Handing them to one computer keeps threads that ran side by side from
-- being counted on two. '' until a computer asks.
ALTER TABLE users ADD COLUMN relay_computer TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN relay_pulled_at INTEGER NOT NULL DEFAULT 0;
