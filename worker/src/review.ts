// What reviewers read. A reviewer gets a person's totals per project and no
// more. Neoadmins and superadmins get everyone with an account, and one
// person's computers and log. Who is which is in staff.ts.
import { Refusal } from './http.ts'
import { type Detail, dur, type Entry, findings, parseStored, remarks } from './log.ts'
import { computers, personDays, personProjects } from './reports.ts'
import { bans } from './staff.ts'

/** How many people the admin list shows. */
const PEOPLE_LIMIT = 1000
/** How many log rows one request returns. */
const LOG_PAGE = 200
/** How many log rows a download holds, which is as many as are kept for one person. */
const LOG_DOWNLOAD = 10_000
/** The longest a calendar day gets, when the clocks go back, in seconds. */
const LONGEST_DAY = 25 * 3600

/** people lists everyone with an account, those who synced most recently first. */
export async function people(env: Env) {
	const { results } = await env.DB.prepare(
		`SELECT u.id, u.name, u.slack_id, u.created_at, u.deleted_at, COUNT(c.id) AS computers,
			COALESCE(SUM(c.engaged_seconds), 0) AS engaged_seconds, MAX(c.synced_at) AS synced_at,
			(SELECT COUNT(*) FROM account_log l WHERE l.user_id = u.id AND l.flagged = 1) AS flagged
		 FROM users u LEFT JOIN computers c ON c.user_id = u.id
		 GROUP BY u.id ORDER BY synced_at DESC NULLS LAST, u.created_at DESC LIMIT ${PEOPLE_LIMIT}`,
	).all()
	return results
}

interface Person {
	id: number
	name: string
	slack_id: string
	created_at: number
	/** When they deleted their account, which keeps its log. */
	deleted_at: number | null
}

/**
 * lookup finds the person a reviewer asked for, by Slack user ID (`slack`)
 * or, with byNumber, by account number (`id`). Account numbers count up from
 * 1, so someone who may only look people up is not let go through them.
 */
async function lookup(env: Env, params: URLSearchParams, byNumber = true): Promise<Person> {
	const id = byNumber ? (params.get('id') ?? '') : ''
	const slack = (params.get('slack') ?? '').trim()
	const columns = 'SELECT id, name, slack_id, created_at, deleted_at FROM users'
	let who: Person | null = null
	if (/^\d{1,15}$/.test(id)) who = await env.DB.prepare(`${columns} WHERE id = ?`).bind(Number(id)).first<Person>()
	else if (slack) who = await env.DB.prepare(`${columns} WHERE slack_id = ? COLLATE NOCASE ORDER BY id LIMIT 1`).bind(slack).first<Person>()
	if (!who) throw new Refusal(404, slack ? `No one with the Slack ID ${slack.slice(0, 32)} has signed in.` : 'No such person.')
	return who
}

type Row = Entry & { id: number }

/**
 * explain turns a log row into what a reviewer reads: the row, what the
 * server made of it, what the report held, and whether the report itself is kept.
 */
function explain(e: Row) {
	const { report_key, ...row } = e
	return { ...row, detail: parseStored<Detail>(e.detail), has_report: report_key != null, findings: e.refusal ? [] : findings(e), remarks: remarks(e) }
}

/**
 * fullLog returns everything in one person's log, newest first, for a
 * reviewer to keep or search outside the site.
 */
export async function fullLog(env: Env, params: URLSearchParams) {
	const who = await lookup(env, params)
	const { results } = await env.DB.prepare(`SELECT * FROM account_log WHERE user_id = ? ORDER BY id DESC LIMIT ${LOG_DOWNLOAD}`).bind(who.id).all<Row>()
	return { person: who, downloaded_at: Date.now(), log: results.map(explain) }
}

/**
 * person returns what a reviewer needs about one person: their computers,
 * what the server noticed, and a page of their log, newest first. `before`
 * continues the log from an earlier page, `show` narrows it to `flagged` or
 * `refused` rows, and `computer` to the history of one computer.
 */
export async function person(env: Env, params: URLSearchParams) {
	const who = await lookup(env, params)
	const before = /^\d{1,15}$/.test(params.get('before') ?? '') ? Number(params.get('before')) : Number.MAX_SAFE_INTEGER
	const show = { flagged: 'AND flagged = 1', refused: `AND refusal != ''` }[params.get('show') ?? ''] ?? ''
	// A computer that isn't one of theirs has no rows in their log.
	const computer = params.get('computer') ?? ''
	const [rows, counts, unchecked, theirComputers, days, projects, theirBans] = await Promise.all([
		env.DB.prepare(`SELECT * FROM account_log WHERE user_id = ?1 AND id < ?2 AND (?3 = '' OR computer_id = ?3) ${show} ORDER BY id DESC LIMIT ${LOG_PAGE + 1}`)
			.bind(who.id, before, computer)
			.all<Row>(),
		env.DB.prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(flagged), 0) AS flagged, COALESCE(SUM(refusal != ''), 0) AS refused FROM account_log WHERE user_id = ?`)
			.bind(who.id)
			.first<{ entries: number; flagged: number; refused: number }>(),
		// History that arrived in a computer's first report, which nothing could be compared with.
		env.DB.prepare(
			`SELECT COALESCE(SUM(engaged_seconds), 0) AS seconds FROM account_log
			 WHERE user_id = ?1 AND refusal = '' AND event != 'remove' AND prev_generated_at IS NULL
				AND computer_id IN (SELECT id FROM computers WHERE user_id = ?1)`,
		)
			.bind(who.id)
			.first<{ seconds: number }>(),
		computers(env, who.id),
		personDays(env, who.id),
		personProjects(env, who.id),
		who.slack_id ? bans(env, who.slack_id) : [],
	])

	// One person can't be engaged for longer than a day lasts, on however many computers.
	const perDay: Record<string, number> = {}
	for (const computer of days) for (const [date, seconds] of Object.entries(computer)) perDay[date] = (perDay[date] ?? 0) + seconds
	const impossible = Object.entries(perDay)
		.filter(([, seconds]) => seconds > LONGEST_DAY)
		.sort(([a], [b]) => (a < b ? 1 : -1))
		.map(([date, seconds]) => `${date}: their computers add up to ${dur(seconds)}, which is more than the day had.`)

	const page = rows.results.slice(0, LOG_PAGE)
	return {
		person: who,
		computers: theirComputers,
		projects,
		bans: theirBans,
		counts,
		unchecked_seconds: unchecked?.seconds ?? 0,
		impossible_days: impossible,
		log: page.map(explain),
		// The ID to pass as `before` for the next page, when there is one.
		more: rows.results.length > LOG_PAGE ? page.at(-1)!.id : null,
	}
}

/**
 * summary returns what a reviewer may see of one person, looked up by Slack
 * ID: who they are and each project's total. It leaves out their days, their
 * computers, their log, and the reports themselves.
 */
export async function summary(env: Env, params: URLSearchParams) {
	const who = await lookup(env, params, false)
	const [theirComputers, projects, flagged, theirBans] = await Promise.all([
		computers(env, who.id),
		personProjects(env, who.id),
		env.DB.prepare('SELECT COUNT(*) AS n FROM account_log WHERE user_id = ? AND flagged = 1').bind(who.id).first<{ n: number }>(),
		bans(env, who.slack_id),
	])
	const ban = theirBans.find((b) => b.active)
	return {
		limited: true,
		person: { name: who.name, slack_id: who.slack_id, created_at: who.created_at, deleted_at: who.deleted_at },
		engaged_seconds: theirComputers.reduce((sum, c) => sum + c.engaged_seconds, 0),
		synced_at: theirComputers[0]?.synced_at ?? null,
		// How many of their reports the server could not square with the one before. A neoadmin can read them.
		flagged_reports: flagged?.n ?? 0,
		ban: ban ? { reason: ban.reason, at: ban.at, until: ban.until } : null,
		// A project's own name only. Its key can be a folder on their computer.
		projects: projects.map(({ name, engaged_seconds }) => ({ name, engaged_seconds })),
	}
}
