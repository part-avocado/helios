-- What the person says about a submission when they make it, such as what
-- the project is or why time arrived late. Reviewers read it; the person's
-- own list shows it back to them.
ALTER TABLE submissions ADD COLUMN submitter_note TEXT;
