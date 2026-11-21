-- Each project's total in a computer's latest report, kept beside it like
-- days, so the next report can say which projects changed.
ALTER TABLE computers ADD COLUMN projects TEXT NOT NULL DEFAULT ''; -- JSON: {project key: [name, engaged seconds]}

-- For reviewers, as JSON: what a report held (its size, and its counts of work
-- blocks, prompts, tokens, and lines) and the days and projects whose totals
-- differ from the report before. NULL for removals and for rows from before
-- this column. Project names are taken out when the person deletes their account.
ALTER TABLE account_log ADD COLUMN detail TEXT;
