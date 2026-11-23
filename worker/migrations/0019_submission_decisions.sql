-- A submission's decision: approved, adjusted, or rejected, with the time it
-- finally credits. Pending submissions have none. Submissions decided before
-- this, by accepting unwitnessed time, were approvals of what they credited.
ALTER TABLE submissions ADD COLUMN final_seconds INTEGER;
UPDATE submissions SET state = 'approved', final_seconds = credited_seconds + accepted_seconds WHERE state = 'decided';
