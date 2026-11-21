// What admins see: everyone with an account, and one person's computers and log.
import { Refusal } from './http.ts'
import { dur, type Entry, findings, remarks } from './log.ts'
import { computers, personDays } from './reports.ts'

/** How many people the admin list shows. */
const PEOPLE_LIMIT = 1000
/** How many log rows one request returns. */
const LOG_PAGE = 200
/** The longest a calendar day gets, when the clocks go back, in seconds. */
const LONGEST_DAY = 25 * 3600

/** people lists everyone for admins, those who synced most recently first. */
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
 * person returns what a reviewer needs about one person, looked up by Slack
 * user ID (`slack`) or by account number (`id`): their computers, what the
 * server noticed, and a page of their log, newest first. `before` continues
 * the log from an earlier page, and `show` narrows it to `flagged` or `refused` rows.
 */
export async function person(env: Env, params: URLSearchParams) {
	const id = params.get('id') ?? ''
	const slack = (params.get('slack') ?? '').trim()
	const columns = 'SELECT id, name, slack_id, created_at, deleted_at FROM users'
	let who: Person | null = null
	if (/^\d{1,15}$/.test(id)) who = await env.DB.prepare(`${columns} WHERE id = ?`).bind(Number(id)).first<Person>()
	else if (slack) who = await env.DB.prepare(`${columns} WHERE slack_id = ? COLLATE NOCASE ORDER BY id LIMIT 1`).bind(slack).first<Person>()
	if (!who) throw new Refusal(404, slack ? `No one with the Slack ID ${slack.slice(0, 32)} has signed in.` : 'No such person.')

	const before = /^\d{1,15}$/.test(params.get('before') ?? '') ? Number(params.get('before')) : Number.MAX_SAFE_INTEGER
	const show = { flagged: 'AND flagged = 1', refused: `AND refusal != ''` }[params.get('show') ?? ''] ?? ''
	const [rows, counts, unchecked, theirComputers, days] = await Promise.all([
		env.DB.prepare(`SELECT * FROM account_log WHERE user_id = ? AND id < ? ${show} ORDER BY id DESC LIMIT ${LOG_PAGE + 1}`)
			.bind(who.id, before)
			.all<Entry & { id: number }>(),
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
		counts,
		unchecked_seconds: unchecked?.seconds ?? 0,
		impossible_days: impossible,
		log: page.map((e) => ({ ...e, findings: e.refusal ? [] : findings(e), remarks: remarks(e) })),
		// The ID to pass as `before` for the next page, when there is one.
		more: rows.results.length > LOG_PAGE ? page.at(-1)!.id : null,
	}
}
