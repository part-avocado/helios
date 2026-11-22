-- Commits of each person's projects, from `commit` records their computers
-- send (they earn no time). recent is JSON for up to 50 commits, newest
-- first: sha, the author's time t, lines added and removed, when the site
-- first saw it (seen), and found: true or false once the hourly check has
-- asked the git host, absent until then. A private or missing repository is
-- "not checked", never "not found".
CREATE TABLE project_git (
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	project_key TEXT NOT NULL,
	checked_at INTEGER,
	claimed INTEGER NOT NULL DEFAULT 0,
	found INTEGER NOT NULL DEFAULT 0,
	recent TEXT NOT NULL DEFAULT '[]',
	PRIMARY KEY (user_id, project_key)
);
CREATE INDEX project_git_checked ON project_git (checked_at);
