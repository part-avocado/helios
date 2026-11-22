-- Public profiles, at /@handle. Every account has one and it is public unless
-- its owner turns it off. A profile shows the handle, never the name or Slack
-- ID that Hack Club Auth gives, since those may be a teenager's real name.

-- The address of the profile: lowercase letters, digits, and hyphens. Every
-- account starts with a neutral one, which its owner can change in Settings.
ALTER TABLE users ADD COLUMN handle TEXT;
ALTER TABLE users ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 1;
UPDATE users SET handle = 'u-' || lower(hex(randomblob(6))) WHERE handle IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX users_handle ON users (handle) WHERE handle IS NOT NULL;

-- Which projects a profile names. Without a row, a project is named when it
-- is a repository on a public host, and otherwise only counted.
CREATE TABLE project_settings (
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	project_key TEXT NOT NULL,
	shown INTEGER NOT NULL, -- 1 to name it, 0 to only count it
	PRIMARY KEY (user_id, project_key)
);
