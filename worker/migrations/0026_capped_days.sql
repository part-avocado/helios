-- A day is credited 16 hours at most. When a day's records added up to more,
-- this keeps what they added up to, in seconds, so reviewers still see it;
-- NULL for a day that was not cut.
ALTER TABLE prompt_days ADD COLUMN uncapped_seconds INTEGER;

-- The review app's list of people adds up each account's own rows
-- (computer_id ''), and finds who has cloud records, without reading the
-- table's large rows.
CREATE INDEX prompt_days_computer ON prompt_days (computer_id, user_id, witnessed_seconds, unwitnessed_seconds);
