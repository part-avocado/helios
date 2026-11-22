-- Times are Unix milliseconds.

-- Keys that anyone with an account makes to read their own stats through the
-- public API, from a script or another site. They can only read, unlike the
-- sync key, which can only upload. The key is shown once and not kept.
CREATE TABLE user_keys (
	id INTEGER PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name TEXT NOT NULL, -- what uses it, so its owner can tell keys apart
	hash TEXT NOT NULL UNIQUE, -- SHA-256 of the key
	hint TEXT NOT NULL, -- how the key starts
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);

CREATE INDEX user_keys_owner ON user_keys (user_id);
