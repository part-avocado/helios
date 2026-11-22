-- Times are Unix milliseconds.

-- "Sign in with teardrop": another site sends a person to /authorize, they
-- choose Allow, and the site gets back a code that it trades once, within a
-- few minutes, for a read key of theirs. Only the code's hash is kept.
CREATE TABLE sign_in_codes (
	hash TEXT PRIMARY KEY, -- SHA-256 of the code
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	site TEXT NOT NULL, -- the origin it sends the person back to, such as https://portfolio.example
	name TEXT NOT NULL, -- what the site calls itself
	redirect_uri TEXT NOT NULL, -- exactly as the site sent it, which it must send again with the code
	challenge TEXT NOT NULL DEFAULT '', -- PKCE: base64url SHA-256 of the site's verifier, if it sent one
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER,
	key_id INTEGER -- the read key it was traded for, revoked if the code is tried again
);

CREATE INDEX sign_in_codes_expiry ON sign_in_codes (expires_at);

-- The site a read key was made for by signing in there, or '' for one made by hand.
ALTER TABLE user_keys ADD COLUMN site TEXT NOT NULL DEFAULT '';
