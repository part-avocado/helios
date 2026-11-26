// What reviewers read. A reviewer gets a person's totals per project and no
// more. Neoadmins and superadmins get everyone with an account, and one
// person's computers and log. Who is which is in staff.ts.
import { cloudComputer } from './events.ts'
import { Refusal } from './http.ts'
import { archivedRows, archiveTotals, type Detail, dur, type Entry, findings, parseStored, remarks } from './log.ts'
import { cappedDays, computers, personTotals, projectBlocks } from './reports.ts'
import { type Level, type User } from './auth.ts'
import { dayKey } from './hub.ts'
import { flags, type Rec } from './timeline.ts'
import { access, bans, slackID } from './staff.ts'
import { moved, projectCommits } from './git.ts'

/** How many people the admin list shows. */
const PEOPLE_LIMIT = 1000
/** How many log rows one request returns. */
const LOG_PAGE = 200
/** How many log rows a download holds, archived ones included. */
const LOG_DOWNLOAD = 100_000
/** The longest a calendar day gets, when the clocks go back, in seconds. */
const LONGEST_DAY = 25 * 3600

/** people lists everyone with an account, those who synced most recently first. */
export async function people(env: Env) {
	const { results } = await env.DB.prepare(
		`SELECT u.id, u.name, u.slack_id, u.created_at, u.deleted_at, COUNT(c.id) AS computers,
			COALESCE(SUM(CASE WHEN c.since != 'records' THEN c.engaged_seconds ELSE 0 END), 0) AS engaged_seconds, MAX(c.synced_at) AS synced_at,
			(SELECT COUNT(*) FROM account_log l WHERE l.user_id = u.id AND l.flagged = 1) + (SELECT COALESCE(SUM(a.flagged), 0) FROM log_archives a WHERE a.user_id = u.id) AS flagged,
			EXISTS (SELECT 1 FROM bans b WHERE b.slack_id = u.slack_id AND u.slack_id != '' AND b.lifted_at IS NULL) AS banned
		 FROM users u LEFT JOIN computers c ON c.user_id = u.id
		 GROUP BY u.id ORDER BY synced_at DESC NULLS LAST, u.created_at DESC LIMIT ${PEOPLE_LIMIT}`,
	).all<{ id: number; engaged_seconds: number }>()
	const byID = new Map(results.map((p) => [p.id, p]))
	// Each account's own rollup of its records, in one pass over the rollup rows (the prompt_days_computer index).
	const { results: rolled } = await env.DB.prepare(`SELECT user_id, SUM(witnessed_seconds + unwitnessed_seconds) AS n FROM prompt_days WHERE computer_id = '' GROUP BY user_id`).all<{ user_id: number; n: number }>()
	for (const r of rolled) {
		const person = byID.get(r.user_id)
		if (person) person.engaged_seconds += r.n
	}
	// A report whose time is also in the records counts once, as in personTotals: one from a computer that has records
	// of its own, and an old Amp-cloud report when the cloud sends records (see duplicateCloud).
	const { results: twice } = await env.DB.prepare(
		`SELECT c.id, c.user_id, c.engaged_seconds, EXISTS (SELECT 1 FROM prompt_days p WHERE p.user_id = c.user_id AND p.computer_id = c.id) AS own
		 FROM computers c WHERE c.since != 'records' AND c.user_id IN (SELECT DISTINCT user_id FROM prompt_days WHERE computer_id = '')`,
	).all<{ id: string; user_id: number; engaged_seconds: number; own: number }>()
	const { results: clouds } = await env.DB.prepare(`SELECT DISTINCT user_id FROM prompt_days WHERE computer_id = 'cloud'`).all<{ user_id: number }>()
	const cloudy = new Map<number, string>()
	for (const { user_id } of clouds) if (byID.has(user_id) && twice.some((c) => c.user_id === user_id)) cloudy.set(user_id, (await cloudComputer(env, { id: user_id } as User)).id)
	for (const c of twice) {
		const person = byID.get(c.user_id)
		if (person && (c.own || cloudy.get(c.user_id) === c.id)) person.engaged_seconds -= c.engaged_seconds
	}
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
 * withCommits adds to each project's work blocks the commits its computers
 * reported, for the graphs: time, lines, whether the git host has it, and
 * whether it dates it differently. The sha and GitHub account go only to
 * those who may read everything.
 */
async function withCommits(env: Env, userID: number, full: boolean) {
	const [projects, git] = await Promise.all([projectBlocks(env, userID), projectCommits(env, userID)])
	return projects.map((p) => ({
		...p,
		// Whether the site checks commits at all: without GITHUB_TOKEN, none is ever checked.
		commit_checks: !!env.GITHUB_TOKEN,
		commits: (git.get(p.key)?.commits ?? []).map((c) => ({
			t: c.t, added: c.added, removed: c.removed, found: c.found ?? null, author_t: c.author_t ?? null, moved: moved(c),
			...(full ? { sha: c.sha, login: c.login ?? null } : {}),
		})),
	}))
}

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
	// Then the archived rows, which are every older one.
	const older = await archivedRows(env, who.id, results.at(-1)?.id ?? Number.MAX_SAFE_INTEGER, LOG_DOWNLOAD)
	return { person: who, downloaded_at: Date.now(), log: [...results, ...older].map(explain) }
}

/**
 * person returns what a reviewer needs about one person: their computers,
 * what the server noticed, and a page of their log, newest first. `before`
 * continues the log from an earlier page, `show` narrows it to `flagged` or
 * `refused` rows, and `computer` to the history of one computer.
 */
export async function person(env: Env, actor: User, params: URLSearchParams) {
	// Someone who has never signed in can still be made a reviewer or banned, by Slack ID.
	if (!params.get('id') && params.get('slack')) {
		const slack = slackID(params.get('slack'))
		const known = await env.DB.prepare('SELECT 1 FROM users WHERE slack_id = ? COLLATE NOCASE').bind(slack).first()
		if (!known) return { signed_in: false, person: { slack_id: slack }, access: await access(env, actor, slack), bans: await bans(env, slack) }
	}
	const who = await lookup(env, params)
	const before = /^\d{1,15}$/.test(params.get('before') ?? '') ? Number(params.get('before')) : Number.MAX_SAFE_INTEGER
	const shown = params.get('show') ?? ''
	const show = { flagged: 'AND flagged = 1', refused: `AND refusal != ''` }[shown] ?? ''
	// A computer that isn't one of theirs has no rows in their log.
	const computer = params.get('computer') ?? ''
	const [rows, counts, unchecked, theirComputers, { days, projects }, capped, theirBans, activity, archived] = await Promise.all([
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
		personTotals(env, who.id),
		cappedDays(env, who.id),
		who.slack_id ? bans(env, who.slack_id) : [],
		// Older log pages draw nothing new.
		params.has('before') ? [] : withCommits(env, who.id, true),
		archiveTotals(env, who.id),
	])
	// When D1's newest rows run out, the page goes on into the archived ones.
	const log = rows.results
	if (log.length <= LOG_PAGE) {
		const keep = (r: Row) => (!computer || r.computer_id === computer) && (shown !== 'flagged' || r.flagged === 1) && (shown !== 'refused' || r.refusal !== '')
		log.push(...(await archivedRows(env, who.id, log.at(-1)?.id ?? before, LOG_PAGE + 1 - log.length, keep)))
	}
	const archivedUnchecked = theirComputers.reduce((n, c) => n + (archived.unchecked[c.id] ?? 0), 0)

	// One person can't be engaged for longer than a day lasts, on however many computers.
	// Records are credited 16 hours a day at most, so their days never add up to
	// more than a day had: a day that was cut is listed with what its records held.
	const perDay: Record<string, number> = {}
	for (const computer of days) for (const [date, seconds] of Object.entries(computer)) perDay[date] = (perDay[date] ?? 0) + seconds
	const cut = new Map(capped.map((d) => [d.day, d.uncapped_seconds]))
	const impossible = [...new Set([...Object.keys(perDay).filter((date) => perDay[date]! > LONGEST_DAY), ...cut.keys()])]
		.sort((a, b) => (a < b ? 1 : -1))
		.map((date) =>
			perDay[date]! > LONGEST_DAY
				? `${date}: their computers add up to ${dur(perDay[date]!)}, which is more than the day had.`
				: `${date}: their records add up to ${dur(cut.get(date)!)}, which was cut to the 16 hours a day is credited.`,
		)

	const page = log.slice(0, LOG_PAGE)
	return {
		signed_in: true,
		person: who,
		// The person's level, and what the visitor may change of it, so the page offers only what the server allows.
		access: who.slack_id ? await access(env, actor, who.slack_id) : null,
		computers: theirComputers,
		projects,
		// Each project's work blocks, for the graphs.
		activity,
		bans: theirBans,
		counts: { entries: (counts?.entries ?? 0) + archived.entries, flagged: (counts?.flagged ?? 0) + archived.flagged, refused: (counts?.refused ?? 0) + archived.refused },
		unchecked_seconds: (unchecked?.seconds ?? 0) + archivedUnchecked,
		impossible_days: impossible,
		log: page.map(explain),
		// The ID to pass as `before` for the next page, when there is one.
		more: log.length > LOG_PAGE ? page.at(-1)!.id : null,
	}
}

/**
 * summary returns what a reviewer may see of one person, looked up by Slack
 * ID: who they are and each project's total. It leaves out their days, their
 * computers, their log, and the reports themselves.
 */
export async function summary(env: Env, params: URLSearchParams) {
	const who = await lookup(env, params, false)
	const [theirComputers, { projects, engaged_seconds }, flagged, theirBans, activity] = await Promise.all([
		computers(env, who.id),
		personTotals(env, who.id),
		env.DB.prepare('SELECT (SELECT COUNT(*) FROM account_log WHERE user_id = ?1 AND flagged = 1) + (SELECT COALESCE(SUM(flagged), 0) FROM log_archives WHERE user_id = ?1) AS n').bind(who.id).first<{ n: number }>(),
		bans(env, who.slack_id),
		withCommits(env, who.id, false),
	])
	const ban = theirBans.find((b) => b.active)
	return {
		limited: true,
		person: { name: who.name, slack_id: who.slack_id, created_at: who.created_at, deleted_at: who.deleted_at },
		engaged_seconds,
		synced_at: theirComputers[0]?.synced_at ?? null,
		// How many of their reports the server could not square with the one before. A neoadmin can read them.
		flagged_reports: flagged?.n ?? 0,
		ban: ban ? { reason: ban.reason, at: ban.at } : null,
		// A project's own name only. Its key can be a folder on their computer.
		projects: projects.map(({ name, engaged_seconds }) => ({ name, engaged_seconds })),
		// Each project's work blocks, for the graphs, by name only too.
		activity: activity.map(({ name, engaged_seconds, blocks, commits, commit_checks }) => ({ name, engaged_seconds, blocks, commits, commit_checks })),
	}
}

/** The most days of records one stats call reads for its flags. */
const FLAG_DAYS = 400

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
/** A project's name: its key's last part, since the key can be a folder on their computer. */
const projectName = (key: string) => key.split(/[\\/]/).filter(Boolean).pop() ?? key

/**
 * stats is what programs read through the protected API: one person's time
 * from start to end (days on their own clock, both included), split into
 * witnessed time, whose records reached the site within 5 minutes of the
 * time they claim, and unwitnessed time, per project and per day. `project`
 * narrows it to some projects, by name, or by key for neoadmins and above. A
 * reviewer (level 2) sees project names only. With `flags=true` it also
 * reads the records behind it and lists what a script that sends records
 * live would leave behind. What to credit is the program's to decide.
 */
export async function stats(env: Env, level: Level, params: URLSearchParams) {
	const who = await lookup(env, params, level < 2)
	const start = params.get('start') || '0000-01-01'
	const end = params.get('end') || '9999-12-31'
	for (const [name, value] of [['start', start], ['end', end]] as const) {
		if (!isDay(value)) throw new Refusal(400, `Give ${name} as a date, such as 2026-01-31.`)
	}
	if (start > end) throw new Refusal(400, 'start is after end.')
	const wanted = new Set((params.get('project') ?? '').split(',').map((p) => p.trim()).filter(Boolean))
	const picked = (key: string) => !wanted.size || wanted.has(projectName(key)) || (level < 2 && wanted.has(key))
	// Records reach D1 within minutes; the person's hub writes what it holds first, so the answer is up to the moment.
	await env.HUB.get(env.HUB.idFromName(String(who.id))).flush()
	const [{ results: rows }, theirBans] = await Promise.all([
		env.DB.prepare(`SELECT day, witnessed_seconds, unwitnessed_seconds, prompts, projects, uncapped_seconds FROM prompt_days WHERE user_id = ? AND computer_id = '' AND day BETWEEN ? AND ? ORDER BY day`)
			.bind(who.id, start, end)
			.all<{ day: string; witnessed_seconds: number; unwitnessed_seconds: number; prompts: number; projects: string; uncapped_seconds: number | null }>(),
		who.slack_id ? bans(env, who.slack_id) : [],
	])
	const projects = new Map<string, { key: string; name: string; witnessed_seconds: number; unwitnessed_seconds: number; prompts: number; first_day: string; last_day: string }>()
	// uncapped_seconds, on a day cut to the 16 hours one is credited: what its records added up to, over every project.
	const days: { date: string; witnessed_seconds: number; unwitnessed_seconds: number; prompts: number; uncapped_seconds?: number }[] = []
	for (const row of rows) {
		const theirs = Object.entries(JSON.parse(row.projects) as Record<string, [number, number, number]>).filter(([key]) => picked(key))
		for (const [key, [witnessed, unwitnessed, prompts]] of theirs) {
			const p = projects.get(key) ?? { key, name: projectName(key), witnessed_seconds: 0, unwitnessed_seconds: 0, prompts: 0, first_day: row.day, last_day: row.day }
			p.witnessed_seconds += witnessed
			p.unwitnessed_seconds += unwitnessed
			p.prompts += prompts
			p.last_day = row.day
			projects.set(key, p)
		}
		// The day's own totals count time on two projects at once once; a narrowed day adds up its projects.
		const sum = (i: number) => theirs.reduce((n, [, v]) => n + v[i]!, 0)
		const day = wanted.size
			? { date: row.day, witnessed_seconds: sum(0), unwitnessed_seconds: sum(1), prompts: sum(2) }
			: { date: row.day, witnessed_seconds: row.witnessed_seconds, unwitnessed_seconds: row.unwitnessed_seconds, prompts: row.prompts }
		if (day.witnessed_seconds || day.unwitnessed_seconds || day.prompts) days.push(row.uncapped_seconds ? { ...day, uncapped_seconds: row.uncapped_seconds } : day)
	}
	const ban = theirBans.find((b) => b.active)
	const total = (k: 'witnessed_seconds' | 'unwitnessed_seconds' | 'prompts') => days.reduce((n, d) => n + d[k], 0)
	return {
		person: { slack_id: who.slack_id, name: who.name, created_at: who.created_at, deleted_at: who.deleted_at },
		ban: ban ? { reason: ban.reason, at: ban.at } : null,
		start: params.get('start') || null,
		end: params.get('end') || null,
		witnessed_seconds: total('witnessed_seconds'),
		unwitnessed_seconds: total('unwitnessed_seconds'),
		prompts: total('prompts'),
		projects: [...projects.values()].sort((a, b) => b.witnessed_seconds - a.witnessed_seconds).map((p) => (level === 2 ? { ...p, key: undefined } : p)),
		days,
		...(params.get('flags') === 'true' ? { flags: await recordFlags(env, who.id, days, picked) } : {}),
	}
}

/** recordFlags reads the records of the days given, of the projects picked, and flags them. */
async function recordFlags(env: Env, userID: number, days: { date: string; witnessed_seconds: number; uncapped_seconds?: number }[], picked: (key: string) => boolean) {
	if (days.length > FLAG_DAYS) throw new Refusal(400, `Flags read at most ${FLAG_DAYS} days of records, and this asks for ${days.length}. Narrow start and end.`)
	const recs: (Rec & { event: string })[] = []
	for (const d of days) {
		const obj = await env.REPORTS.get(dayKey(userID, d.date))
		if (!obj) continue
		for (const line of (await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text()).split('\n')) {
			if (!line) continue
			const r = JSON.parse(line) as Rec & { event: string; project: string }
			if (picked(r.project)) recs.push(r)
		}
	}
	return flags(recs, days.map((d) => ({ day: d.date, witnessed_seconds: d.witnessed_seconds, uncapped_seconds: d.uncapped_seconds })))
}
