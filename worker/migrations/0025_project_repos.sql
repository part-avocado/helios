-- The GitHub repositories a person links to a project, as a JSON array of
-- "github.com/owner/name". NULL keeps the default: the repository the
-- project's key names, if it is on a public host, and otherwise none.
ALTER TABLE project_settings ADD COLUMN repos TEXT;
