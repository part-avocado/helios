-- Bans have no length: every ban holds until someone lifts it. Times are Unix
-- milliseconds. bans.until stays, always empty from here on.

-- The end each timed ban was given, so its history still says so.
ALTER TABLE bans ADD COLUMN was_until INTEGER;
UPDATE bans SET was_until = until WHERE until IS NOT NULL;

-- A timed ban that already ran out is over. Without this, dropping the
-- check on its end would put it back in force. No one lifted it, so
-- lifted_by stays empty.
UPDATE bans SET lifted_at = until
	WHERE lifted_at IS NULL AND until IS NOT NULL AND until <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;

-- A timed ban still in force becomes permanent, noted in the staff log with
-- the date it was to end, so a reviewer can lift it then if that still stands.
INSERT INTO staff_log (at, by_slack_id, action, slack_id, detail)
	SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'teardrop', 'permanent', slack_id,
		'was to end ' || strftime('%Y-%m-%d %H:%M UTC', until / 1000, 'unixepoch')
	FROM bans WHERE lifted_at IS NULL AND until IS NOT NULL;
UPDATE bans SET until = NULL WHERE lifted_at IS NULL AND until IS NOT NULL;
