// The account log: every report a person's computers sent and every computer
// they removed, with what the server noticed about each. Reviewers read it.
//
// The numbers in a report come from the person's own computer, so the server
// can't prove them. What it can do is compare each report with the one before
// it, using its own clock, and flag the ones that don't add up.

const DAY = 86400_000
/** How many of a person's newest log rows stay in D1. Older ones move to R2, ARCHIVE at a time, and are kept for good. */
const LOG_KEPT = 200
const ARCHIVE = 200
/** Seconds a report may be off by before it is flagged, for clocks that disagree. */
const SLACK = 300
/**
 * Seconds of engaged time that a report may add from before the report before
 * it. teardrop syncs when a reply ends, and a reply that ends earns up to four
 * minutes of watching the agent work, which may all lie before a sync that
 * another session started meanwhile.
 */
const WATCHED = 240
/** The most days kept from one report. A year's report has 366 at most. */
const MAX_DAYS = 400
/** The most projects kept from one report, the largest first. */
const MAX_PROJECTS = 300
/** The most changed projects listed on one log row. */
const MAX_PROJECT_CHANGES = 100

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
	/** A Detail as JSON, or null when nothing of the report could be read. */
	detail: string | null
	/** Where the report is kept in full, or null when it isn't. */
	report_key: string | null
}

/** A day or project whose total differs between two reports: its date or name, and its seconds before and now. */
export type Change = [name: string, before: number, now: number]

/** Detail is what a report held, and how it differed from the one before, for reviewers to read. */
export interface Detail {
	/** The size of the signed report. */
	bytes: number
	blocks: number
	/** When its first work block started and its last one ended, in Unix milliseconds. */
	first_block: number | null
	last_block: number | null
	active_days: number
	project_count: number
	prompts: number
	/** Prompts teardrop left out of the time. */
	skipped_prompts: number
	tokens_in: number
	tokens_out: number
	lines_added: number
	lines_removed: number
	lines_kept: number
	tools: string[]
	/** Set when the report is the count of the person's Amp cloud threads. */
	cloud?: boolean
	/**
	 * Whether the lists below are everything the report held, because there
	 * was no earlier report to compare it with. Otherwise they are what changed.
	 */
	full?: boolean
	/** Newest first. */
	days?: Change[]
	/** Largest change first. Removed when the person deletes their account. */
	projects?: Change[]
	/** How many more projects changed than are listed. */
	more_projects?: number
}

/** The parts of a report that are read here. Everything in it comes from the person's computer, so nothing is trusted to be there. */
export interface ReportBody {
	engaged_seconds?: unknown
	blocks?: unknown
	projects?: unknown
	days?: unknown
}

/** count reads a number that should be a whole, positive one. */
const count = (value: unknown) => {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

export const dur = (seconds: number) => {
	const m = Math.round(Math.max(0, seconds) / 60)
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * dayTotals reads a report's engaged seconds per date, ignoring anything
 * malformed. A report from before teardrop 0.4 has no such totals, so its
 * work blocks are added up instead, by the UTC date each started on.
 */
export function dayTotals(report: ReportBody | undefined): Record<string, number> {
	const all: Record<string, number> = {}
	const add = (date: unknown, engaged: unknown) => {
		const seconds = count(engaged)
		if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && seconds) all[date] = (all[date] ?? 0) + seconds
	}
	if (Array.isArray(report?.days)) {
		for (const d of report.days) add(d?.date, d?.engaged_seconds)
	} else if (Array.isArray(report?.blocks)) {
		for (const b of report.blocks) {
			const start = Date.parse(typeof b?.start === 'string' ? b.start : '')
			if (Number.isFinite(start)) add(new Date(start).toISOString().slice(0, 10), b?.engaged_seconds)
		}
	}
	const latest = Object.keys(all).sort().slice(-MAX_DAYS)
	return Object.fromEntries(latest.map((date) => [date, all[date]!]))
}

/** projectTotals reads each project's engaged seconds from a report: {key: [name, seconds]}, for its largest projects. */
export function projectTotals(report: ReportBody | undefined): Record<string, [string, number]> {
	const all = new Map<string, [string, number]>()
	const add = (project: unknown, engaged: unknown) => {
		const p = (project ?? {}) as { key?: unknown; name?: unknown }
		const key = String(p.key ?? p.name ?? '').slice(0, 200)
		const seconds = count(engaged)
		if (!key || !seconds) return
		all.set(key, [String(p.name ?? '').slice(0, 80) || key.slice(0, 80), (all.get(key)?.[1] ?? 0) + seconds])
	}
	if (Array.isArray(report?.projects)) for (const p of report.projects) add(p?.project, p?.engaged_seconds)
	// Without totals per project, add up the work blocks, which counts time on two projects at once for both.
	if (!all.size && Array.isArray(report?.blocks)) for (const b of report.blocks) add(b?.project, b?.engaged_seconds)
	return Object.fromEntries([...all].sort((a, b) => b[1][1] - a[1][1]).slice(0, MAX_PROJECTS))
}

/** summarize counts what a report holds. */
export function summarize(report: ReportBody | undefined, bytes: number): Detail {
	const d: Detail = { bytes, blocks: 0, first_block: null, last_block: null, active_days: 0, project_count: 0, prompts: 0, skipped_prompts: 0, tokens_in: 0, tokens_out: 0, lines_added: 0, lines_removed: 0, lines_kept: 0, tools: [] }
	const tools = new Set<string>()
	for (const b of Array.isArray(report?.blocks) ? report.blocks : []) {
		d.blocks++
		const start = Date.parse(typeof b?.start === 'string' ? b.start : '')
		const end = Date.parse(typeof b?.end === 'string' ? b.end : '')
		if (Number.isFinite(start)) d.first_block = Math.min(d.first_block ?? start, start)
		if (Number.isFinite(end)) d.last_block = Math.max(d.last_block ?? end, end)
		d.prompts += count(b?.prompts)
		d.tokens_in += count(b?.tokens_in)
		d.tokens_out += count(b?.tokens_out)
		d.lines_added += count(b?.lines_added)
		d.lines_removed += count(b?.lines_removed)
		d.lines_kept += count(b?.lines_kept)
		for (const tool of Array.isArray(b?.tools) ? b.tools : []) if (tools.size < 20) tools.add(String(tool).slice(0, 40))
	}
	for (const p of Array.isArray(report?.projects) ? report.projects : []) {
		d.skipped_prompts += count(p?.noise_prompts) + count(p?.repeat_prompts) + count(p?.autopilot_prompts)
	}
	d.tools = [...tools].sort()
	d.active_days = Object.keys(dayTotals(report)).length
	d.project_count = Object.keys(projectTotals(report)).length
	return d
}

/**
 * dayChanges lists the days whose totals differ between two reports, newest
 * first. With no report before, it lists every day of the new one. Days from
 * before the new report's first have left its window and are not listed.
 */
export function dayChanges(before: Record<string, number> | null, now: Record<string, number>): Change[] {
	const first = Object.keys(now).sort()[0] ?? ''
	const dates = new Set([...Object.keys(before ?? {}), ...Object.keys(now)])
	return [...dates]
		.filter((date) => date >= first)
		.map((date): Change => [date, before?.[date] ?? 0, now[date] ?? 0])
		.filter(([, was, is]) => was !== is)
		.sort((a, b) => (a[0] < b[0] ? 1 : -1))
}

/** projectChanges lists the projects whose totals differ between two reports, the largest change first, and says how many it left out. */
export function projectChanges(before: Record<string, [string, number]> | null, now: Record<string, [string, number]>): { projects: Change[]; more_projects?: number } {
	const was = new Map(Object.entries(before ?? {}))
	const is = new Map(Object.entries(now))
	const all = [...new Set([...was.keys(), ...is.keys()])]
		.map((key): Change => [is.get(key)?.[0] ?? was.get(key)?.[0] ?? key, was.get(key)?.[1] ?? 0, is.get(key)?.[1] ?? 0])
		.filter(([, a, b]) => a !== b)
		.sort((a, b) => Math.abs(b[2] - b[1]) - Math.abs(a[2] - a[1]))
	const out: { projects: Change[]; more_projects?: number } = { projects: all.slice(0, MAX_PROJECT_CHANGES) }
	if (all.length > MAX_PROJECT_CHANGES) out.more_projects = all.length - MAX_PROJECT_CHANGES
	return out
}

/** parseStored reads JSON this server stored, such as a Detail or project totals. */
export function parseStored<T>(stored: string | null): T | null {
	try {
		return stored ? (JSON.parse(stored) as T) : null
	} catch {
		return null
	}
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
	// A cloud report is counted from the events of every cloud thread. A thread
	// only says that a turn is over when it is, and the minutes that earns lie
	// before the report another thread made meanwhile. So the rule below doesn't
	// hold for it; the one above does.
	if (comparable(e) && !parseStored<Detail>(e.detail)?.cloud) {
		// Engaged time counts each moment once, so it can't grow faster than the clock.
		const added = e.engaged_seconds - e.prev_engaged_seconds!
		const passed = (e.at - e.prev_generated_at!) / 1000
		if (added > passed + WATCHED + SLACK) out.push(`Added ${dur(added)} of engaged time, but only ${dur(passed)} had passed since the report before it.`)
	}
	return out
}

/** remarks lists what else a reviewer should know about a log row. None of it is a fault. */
export function remarks(e: Entry): string[] {
	if (e.refusal) return []
	if (e.event === 'remove') return [`Removed in Settings. It had ${dur(e.engaged_seconds)}.`]
	if (e.event === 'delete') return [`The person deleted their account in Settings. Its computers had ${dur(e.engaged_seconds)} between them.`]
	const out: string[] = []
	if (parseStored<Detail>(e.detail)?.cloud) out.push('Counted from their Amp cloud threads. Time is not checked against the clock, because a turn that ends adds minutes from before the last report.')
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
	'user_id, at, event, computer_id, refusal, flagged, generated_at, teardrop_version, since, engaged_seconds, prev_generated_at, prev_since, prev_engaged_seconds, prev_teardrop_version, past_added_seconds, detail, report_key'

/** A log row as kept, with its ID. */
export type LogRow = Entry & { id: number; user_id: number }

const gz = async (text: string) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()

/** readArchive returns the rows of one archive of the log, oldest first. */
export async function readArchive(env: Env, key: string): Promise<LogRow[]> {
	const obj = await env.REPORTS.get(key)
	if (!obj) return []
	const text = await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text()
	return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogRow)
}

/** writeArchive stores rows as one archive. */
export async function writeArchive(env: Env, key: string, rows: LogRow[]): Promise<void> {
	await env.REPORTS.put(key, await gz(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'))
}

/**
 * archiveLog moves a person's oldest log rows to R2 once D1 holds more than
 * LOG_KEPT + ARCHIVE of them, so D1 holds a few hundred rows per person and
 * nothing is ever dropped. Two runs at once write the same archive.
 */
export async function archiveLog(env: Env, userID: number): Promise<void> {
	const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM account_log WHERE user_id = ?').bind(userID).first<{ n: number }>()
	if ((n?.n ?? 0) <= LOG_KEPT + ARCHIVE) return
	const { results } = await env.DB.prepare(`SELECT * FROM account_log WHERE user_id = ? ORDER BY id LIMIT ${ARCHIVE}`).bind(userID).all<LogRow>()
	const first = results[0]?.id, last = results.at(-1)?.id
	if (first == null || last == null) return
	// Outside the person's own prefix, so deleting their account keeps their log.
	const key = `log/${userID}/${String(first).padStart(15, '0')}-${last}.ndjson.gz`
	await writeArchive(env, key, results)
	const unchecked: Record<string, number> = {}
	for (const r of results) if (!r.refusal && r.event !== 'remove' && r.prev_generated_at == null && r.computer_id) unchecked[r.computer_id] = (unchecked[r.computer_id] ?? 0) + r.engaged_seconds
	await env.DB.batch([
		env.DB.prepare('INSERT OR IGNORE INTO log_archives (user_id, key, first_id, last_id, rows, flagged, refused, unchecked, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
			userID, key, first, last, results.length, results.filter((r) => r.flagged).length, results.filter((r) => r.refusal).length, JSON.stringify(unchecked), Date.now()),
		env.DB.prepare('DELETE FROM account_log WHERE user_id = ? AND id >= ? AND id <= ?').bind(userID, first, last),
	])
}

/**
 * archivedRows returns up to limit of a person's archived log rows with IDs
 * below before that keep accepts, newest first.
 */
export async function archivedRows(env: Env, userID: number, before: number, limit: number, keep: (r: LogRow) => boolean = () => true): Promise<LogRow[]> {
	const { results } = await env.DB.prepare('SELECT key FROM log_archives WHERE user_id = ? AND first_id < ? ORDER BY last_id DESC').bind(userID, before).all<{ key: string }>()
	const out: LogRow[] = []
	for (const a of results) {
		if (out.length >= limit) break
		out.push(...(await readArchive(env, a.key)).filter((r) => r.id < before && keep(r)).reverse())
	}
	return out.slice(0, limit)
}

/** logRow returns one log row by ID, from D1 or its archive. */
export async function logRow(env: Env, id: number): Promise<LogRow | null> {
	const row = await env.DB.prepare('SELECT * FROM account_log WHERE id = ?').bind(id).first<LogRow>()
	if (row) return row
	const a = await env.DB.prepare('SELECT key FROM log_archives WHERE first_id <= ? AND last_id >= ?').bind(id, id).first<{ key: string }>()
	return a ? ((await readArchive(env, a.key)).find((r) => r.id === id) ?? null) : null
}

/** archiveTotals returns how many of a person's archived rows there are, flagged, and refused, and each computer's unchecked seconds in them. */
export async function archiveTotals(env: Env, userID: number) {
	const { results } = await env.DB.prepare('SELECT rows, flagged, refused, unchecked FROM log_archives WHERE user_id = ?').bind(userID).all<{ rows: number; flagged: number; refused: number; unchecked: string }>()
	const unchecked: Record<string, number> = {}
	for (const r of results) for (const [c, s] of Object.entries(JSON.parse(r.unchecked) as Record<string, number>)) unchecked[c] = (unchecked[c] ?? 0) + s
	return { entries: results.reduce((n, r) => n + r.rows, 0), flagged: results.reduce((n, r) => n + r.flagged, 0), refused: results.reduce((n, r) => n + r.refused, 0), unchecked }
}

/**
 * logEntry returns the statements that add e to a person's log. Given `when`,
 * a condition with ? for each of its values, the row is only added if it holds.
 */
export function logEntry(env: Env, userID: number, e: Entry, when = '1', ...values: unknown[]): D1PreparedStatement[] {
	const row = [userID, e.at, e.event, e.computer_id, e.refusal, e.flagged, e.generated_at, e.teardrop_version, e.since, e.engaged_seconds, e.prev_generated_at, e.prev_since, e.prev_engaged_seconds, e.prev_teardrop_version, e.past_added_seconds, e.detail, e.report_key]
	return [env.DB.prepare(`INSERT INTO account_log (${COLUMNS}) SELECT ${row.map(() => '?').join(', ')} WHERE ${when}`).bind(...row, ...values)]
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
	return statements
}

/** The last report of a computer the person removed, which a report from it is compared with when it comes back. */
export async function removedReport(env: Env, userID: number, computerID: string) {
	return env.DB.prepare(`SELECT generated_at, since, engaged_seconds, teardrop_version FROM account_log WHERE user_id = ? AND computer_id = ? AND event = 'remove' ORDER BY id DESC LIMIT 1`)
		.bind(userID, computerID)
		.first<{ generated_at: number | null; since: string; engaged_seconds: number; teardrop_version: string }>()
}
