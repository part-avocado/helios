-- Times are Unix milliseconds.

-- `teardrop login`: the CLI asks for a login and shows its person a short
-- code; signed in on the site, they type the code at /connect and allow it;
-- the CLI, which polls with a secret code of its own, then gets their sync
-- key once. Only the codes' hashes are kept. An allowed login stays, as a
-- record of which computer was connected to which account and when.
CREATE TABLE cli_logins (
	hash TEXT PRIMARY KEY, -- SHA-256 of the secret code the CLI polls with
	user_code_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the short code the person types
	computer_id TEXT NOT NULL, -- the td- ID of the computer that asked, shown on the allow page
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	user_id INTEGER REFERENCES users (id) ON DELETE CASCADE, -- who allowed it
	allowed_at INTEGER,
	denied_at INTEGER,
	collected_at INTEGER -- when the CLI got the key, which it can only once
);

CREATE INDEX cli_logins_expiry ON cli_logins (expires_at);
