-- Times are Unix milliseconds.

-- Sync keys beyond the account's own (users.api_key): one for each computer
-- connected with `teardrop login`, named by its computer ID, and any a person
-- makes by hand under Settings. Each sends and submits as the person, and
-- each can be revoked alone. Only a key's hash is kept.
CREATE TABLE sync_keys (
	id INTEGER PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name TEXT NOT NULL, -- the computer's td- ID, or what the person called it
	hash TEXT NOT NULL UNIQUE, -- SHA-256 of the key
	hint TEXT NOT NULL, -- how the key starts
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);

CREATE INDEX sync_keys_owner ON sync_keys (user_id);
