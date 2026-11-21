// The account log: every report a person's computers sent and every computer
// they removed, with what the server noticed about each. Reviewers read it.
//
// The numbers in a report come from the person's own computer, so the server
// can't prove them. What it can do is compare each report with the one before
// it, using its own clock, and flag the ones that don't add up.

const DAY = 86400_000
/** How many log rows are kept per person: this many flagged, and this many not. */
const LOG_ROWS = 5000
/** Seconds a report may be off by before it is flagged, for clocks that disagree. */
const SLACK = 300
/** The most days kept from one report. A year's report has 366 at most. */
const MAX_DAYS = 400

export type LogEvent = 'sync' | 'upload' | 'remove' | 'delete'

/** A row of account_log, without its ID. */
export interface Entry {
	at: number
	event: LogEvent
	computer_id: string
	refusal: string
	flagged: number
	generated_at: number | null
	teardrop_version: string
	since: string
	engaged_seconds: number
	prev_generated_at: number | null
	prev_since: string | null
	prev_engaged_seconds: number | null
	prev_teardrop_version: string | null
	past_added_seconds: number | null
}

export const dur = (seconds: number) => {
	const m = Math.round(Math.max(0, seconds) / 60)
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** dayTotals reads a report's engaged seconds per date, ignoring anything malformed. */
export function dayTotals(days: unknown): Record<string, number> {
	const out: Record<string, number> = {}
	if (!Array.isArray(days)) return out
	for (const d of days.slice(-MAX_DAYS) as { date?: unknown; engaged_seconds?: unknown }[]) {
		const seconds = Number(d?.engaged_seconds)
		if (typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && seconds > 0 && Number.isFinite(seconds)) {
			out[d.date] = (out[d.date] ?? 0) + Math.round(seconds)
		}
	}
	return out
}

/** parseDays reads day totals stored by dayTotals. */
export function parseDays(stored: string): Record<string, number> {
	try {
		return stored ? JSON.parse(stored) : {}
	} catch {
		return {}
	}
}

/**
 * pastAdded returns how many seconds a report added to days that were already
 * over when the report before it was made. A real log can't grow there.
 *
 * Dates are in the computer's own time zone, which the server doesn't know.
 * So a day counts as over only if it had ended everywhere on Earth, and time
 * that only moved between such days (a change of time zone) adds nothing.
 */
export function pastAdded(before: Record<string, number>, now: Record<string, number>, beforeGeneratedAt: number): number {
	const over = new Date(beforeGeneratedAt - DAY).toISOString().slice(0, 10)
	// Days before the new report's first have left its window; they weren't taken away.
	const first = Object.keys(now).sort()[0]
	if (!first) return 0
	let added = 0
	for (const date of new Set([...Object.keys(before), ...Object.keys(now)])) {
		if (date >= first && date < over) added += (now[date] ?? 0) - (before[date] ?? 0)
	}
	return Math.max(0, added)
}

/** comparable says whether a stored report covers the same window as the one before it. */
const comparable = (e: Entry) => e.prev_generated_at != null && e.prev_engaged_seconds != null && e.prev_since === e.since

/**
 * findings lists what is wrong with a stored report, in words for a reviewer.
 * A report with any is flagged.
 */
export function findings(e: Entry): string[] {
	const out: string[] = []
	if ((e.past_added_seconds ?? 0) > SLACK) {
		out.push(`Added ${dur(e.past_added_seconds!)} to days that were already over when the report before it was made.`)
	}
	if (comparable(e)) {
		// Engaged time counts each moment once, so it can't grow faster than the clock.
		const added = e.engaged_seconds - e.prev_engaged_seconds!
		const passed = (e.at - e.prev_generated_at!) / 1000
		if (added > passed + SLACK) out.push(`Added ${dur(added)} of engaged time, but only ${dur(passed)} had passed since the report before it.`)
	}
	return out
}

/** remarks lists what else a reviewer should know about a log row. None of it is a fault. */
export function remarks(e: Entry): string[] {
	if (e.refusal) return []
	if (e.event === 'remove') return [`Removed in Settings. It had ${dur(e.engaged_seconds)}.`]
	if (e.event === 'delete') return [`The person deleted their account in Settings. Its computers had ${dur(e.engaged_seconds)} between them.`]
	const out: string[] = []
	if (e.prev_generated_at == null) {
		// A computer's first sync brings its earlier history with it, which nothing can be compared with.
		if (e.engaged_seconds > 0) out.push(`First sync: ${dur(e.engaged_seconds)} of earlier history, unchecked.`)
	} else if (!comparable(e)) {
		out.push(
			e.prev_since
				? `Covers ${e.since || 'an unknown window'}; the report before it covered ${e.prev_since}, so the two could not be compared.`
				: 'The report before it was stored before this log existed, so the two could not be compared.',
		)
	} else if (e.past_added_seconds == null) {
		out.push('The computer was removed and added again, so its days could not be compared.')
	}
	if (e.prev_teardrop_version != null && e.prev_teardrop_version !== e.teardrop_version) {
		out.push(`teardrop changed from ${e.prev_teardrop_version || 'an unknown version'} to ${e.teardrop_version || 'an unknown version'} between the two reports. A new version can count past days differently.`)
	}
	if (!/^v\d+\.\d+\.\d+$/.test(e.teardrop_version)) out.push(`Sent by ${e.teardrop_version ? `teardrop ${e.teardrop_version}` : 'an unnamed build'}, which is not a released version.`)
	if (e.generated_at != null && e.at - e.generated_at > 3600_000) out.push(`Made ${dur((e.at - e.generated_at) / 1000)} before it arrived.`)
	return out
}

const COLUMNS =
	'user_id, at, event, computer_id, refusal, flagged, generated_at, teardrop_version, since, engaged_seconds, prev_generated_at, prev_since, prev_engaged_seconds, prev_teardrop_version, past_added_seconds'

/**
 * trim drops a person's oldest log rows once they have more than LOG_ROWS.
 * Flagged rows are counted apart from the rest, so a flood of other rows
 * can't push them out.
 */
const trim = (env: Env, userID: number, flagged: number) =>
	env.DB.prepare(
		`DELETE FROM account_log WHERE user_id = ?1 AND flagged = ?2
			AND id <= (SELECT id FROM account_log WHERE user_id = ?1 AND flagged = ?2 ORDER BY id DESC LIMIT 1 OFFSET ${LOG_ROWS})`,
	).bind(userID, flagged)

/**
 * logEntry returns the statements that add e to a person's log. Given `when`,
 * a condition with ? for each of its values, the row is only added if it holds.
 */
export function logEntry(env: Env, userID: number, e: Entry, when = '1', ...values: unknown[]): D1PreparedStatement[] {
	const row = [userID, e.at, e.event, e.computer_id, e.refusal, e.flagged, e.generated_at, e.teardrop_version, e.since, e.engaged_seconds, e.prev_generated_at, e.prev_since, e.prev_engaged_seconds, e.prev_teardrop_version, e.past_added_seconds]
	return [env.DB.prepare(`INSERT INTO account_log (${COLUMNS}) SELECT ${row.map(() => '?').join(', ')} WHERE ${when}`).bind(...row, ...values), trim(env, userID, e.flagged)]
}

/**
 * logRemoval returns the statements that note the removal of one of a
 * person's computers. Without a computerID they note the deletion of the
 * account, and the removal of every computer with it. They must run before
 * the computers are deleted.
 */
export function logRemoval(env: Env, userID: number, computerID?: string): D1PreparedStatement[] {
	const now = Date.now()
	const statements = [
		env.DB.prepare(
			`INSERT INTO account_log (user_id, at, event, computer_id, generated_at, teardrop_version, since, engaged_seconds)
			 SELECT user_id, ?1, 'remove', id, generated_at, teardrop_version, since, engaged_seconds
			 FROM computers WHERE user_id = ?2 AND (?3 IS NULL OR id = ?3)`,
		).bind(now, userID, computerID ?? null),
	]
	if (computerID === undefined) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO account_log (user_id, at, event, engaged_seconds)
				 SELECT ?1, ?2, 'delete', COALESCE(SUM(engaged_seconds), 0) FROM computers WHERE user_id = ?1`,
			).bind(userID, now),
		)
	}
	return [...statements, trim(env, userID, 0)]
}

/** The last report of a computer the person removed, which a report from it is compared with when it comes back. */
export async function removedReport(env: Env, userID: number, computerID: string) {
	return env.DB.prepare(`SELECT generated_at, since, engaged_seconds, teardrop_version FROM account_log WHERE user_id = ? AND computer_id = ? AND event = 'remove' ORDER BY id DESC LIMIT 1`)
		.bind(userID, computerID)
		.first<{ generated_at: number | null; since: string; engaged_seconds: number; teardrop_version: string }>()
}
