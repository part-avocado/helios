-- Witnessed time a submission left uncredited because it went over the
-- site's daily or weekly cap (DAILY_CAP_HOURS, WEEKLY_CAP_HOURS).
ALTER TABLE submissions ADD COLUMN capped_seconds INTEGER NOT NULL DEFAULT 0;
