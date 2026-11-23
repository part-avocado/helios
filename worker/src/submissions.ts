// Project submissions. A submission is a snapshot of records the site already
// holds: the project's time across the person's computers, split into what
// the site witnessed (records that reached it within 5 minutes of the time
// they claim) and what it didn't. Only witnessed time is credited, less what
// earlier submissions of the project covered. A reviewer approves,
// adjusts, or rejects each one. Nothing is uploaded with a submission, and no
// prompt text is ever on the site.
import type { User } from './auth.ts'
import { dayKey } from './hub.ts'
import { moved, projectCommits } from './git.ts'
import { Refusal } from './http.ts'
import { capSpans, credit, flags, type Rec, type Stretch } from './timeline.ts'

type Span = [number, number]

/** The most days of records one submission reads. */
const MAX_DAYS = 400

export interface SubmissionRow {
	id: string
	user_id: number
	project_key: string
	project_name: string
	received_at: number
	witnessed_seconds: number
	unwitnessed_seconds: number
	earlier_overlap_seconds: number
	credited_seconds: number
	accepted_seconds: number
	/** Time accepted by hand for gaps with commits. */
	gap_seconds: number
	/** Witnessed time left uncredited by the daily and weekly caps. */
	capped_seconds: number
	/** What it finally credits, once decided. */
	final_seconds: number | null
	prompts: number
	tokens_in: number
	tokens_out: number
	state: string
	decided_by: string | null
	decided_at: number | null
	note: string | null
	/** What the person said about it when they submitted it. */
	submitter_note: string | null
	snapshot_key: string
	imported: number
}

interface Snapshot {
	project: { key: string; name: string }
	days: { day: string; key: string; sha256: string }[]
	witnessed: Span[]
	unwitnessed: Span[]
	earlier: Span[]
	/** What it credited, after the caps. Older snapshots credited witnessed less earlier. */
	credited?: Span[]
	/** Uncredited gaps between the project's stretches that hold commits GitHub has, which a neoadmin may accept. */
	commit_gaps?: Gap[]
}

/** A gap between credited stretches with commits in it. */
interface Gap {
	start: number
	end: number
	/** The most of it that may be accepted, in seconds. */
	most: number
	commits: { sha: string; t: number; added: number; removed: number }[]
}

/** The most one gap with commits may be credited by hand: an afternoon of coding between prompts, not a day. */
const GAP_MOST = 2 * 3600

/** A cap in hours from a setting, in ms; unset or not a positive number is no cap. */
const capOf = (v: string | undefined) => (Number(v) > 0 ? Number(v) * 3600_000 : Infinity)

function merge(list: Span[]): Span[] {
	const out: Span[] = []
	for (const [s, e] of [...list].sort((a, b) => a[0] - b[0])) {
		const last = out.at(-1)
		if (last && s <= last[1]) last[1] = Math.max(last[1], e)
		else out.push([s, e])
	}
	return out
}

/** minus returns the parts of a that b doesn't cover. Both are merged. */
function minus(a: Span[], b: Span[]): Span[] {
	const out: Span[] = []
	for (let [s, e] of a) {
		for (const [bs, be] of b) {
			if (be <= s || bs >= e) continue
			if (bs > s) out.push([s, bs])
			s = Math.max(s, be)
			if (s >= e) break
		}
		if (e > s) out.push([s, e])
	}
	return out
}

const seconds = (l: Span[]) => Math.round(l.reduce((n, [s, e]) => n + e - s, 0) / 1000)
const nameOf = (key: string) => key.split('/').filter(Boolean).pop() ?? key

async function gunzip(obj: R2ObjectBody): Promise<string> {
	return new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text()
}

async function gzip(text: string): Promise<ArrayBuffer> {
	return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
}

type Kept = Rec & { computer: string; event: string }

/** projectRecords reads a person's records of one project from R2, and the days they came from. */
async function projectRecords(env: Env, userID: number, projectKey: string): Promise<{ recs: Kept[]; days: Snapshot['days'] }> {
	const { results } = await env.DB.prepare(`SELECT day, projects, sha256 FROM prompt_days WHERE user_id = ? AND computer_id = '' ORDER BY day DESC LIMIT ${MAX_DAYS}`)
		.bind(userID)
		.all<{ day: string; projects: string; sha256: string }>()
	const days = results.filter((r) => projectKey in (JSON.parse(r.projects) as Record<string, unknown>)).reverse()
	const recs: Kept[] = []
	for (const d of days) {
		const obj = await env.REPORTS.get(dayKey(userID, d.day))
		if (!obj) continue
		for (const line of (await gunzip(obj)).split('\n')) {
			if (!line) continue
			const r = JSON.parse(line) as Kept
			if (r.project === projectKey) recs.push(r)
		}
	}
	return { recs, days: days.map((d) => ({ day: d.day, key: dayKey(userID, d.day), sha256: d.sha256 })) }
}

/** stretches credits records session by session, and merges what they cover into witnessed and unwitnessed time. */
function stretches(recs: Rec[]): { witnessed: Span[]; unwitnessed: Span[] } {
	const sessions = new Map<string, Rec[]>()
	for (const r of recs) {
		const k = `${r.tool}\0${r.session}`
		sessions.set(k, [...(sessions.get(k) ?? []), r])
	}
	const all: Stretch[] = []
	for (const list of sessions.values()) all.push(...credit(list))
	const witnessed = merge(all.filter((s) => s.witnessed).map((s) => [s.start, s.end]))
	return { witnessed, unwitnessed: minus(merge(all.map((s) => [s.start, s.end])), witnessed) }
}

/**
 * commitGaps lists the gaps between the project's credited stretches (spans,
 * merged) that hold a commit GitHub found and dates as claimed, less gaps an
 * earlier submission listed. A commit's time is its author's to set, so this
 * is evidence for a person to weigh, never credit by itself.
 */
function commitGaps(spans: Span[], recs: Rec[], found: Set<string>, listed: Span[]): Gap[] {
	const commits = recs.filter((r) => r.sha && found.has(r.sha))
	const gaps: Gap[] = []
	for (let i = 1; i < spans.length; i++) {
		const [start, end] = [spans[i - 1]![1], spans[i]![0]]
		const inside = commits.filter((c) => c.t > start && c.t < end)
		if (!inside.length || listed.some(([a, b]) => a < end && b > start)) continue
		gaps.push({ start, end, most: Math.min(Math.round((end - start) / 1000), GAP_MOST), commits: inside.map((c) => ({ sha: c.sha!, t: c.t, added: c.added ?? 0, removed: c.removed ?? 0 })) })
	}
	return gaps
}

/** submit makes a submission of one of the person's projects from the records the site holds. */
export async function submit(env: Env, user: User, body: Record<string, unknown>): Promise<SubmissionRow> {
	if ('signed' in body || 'logs' in body) {
		throw new Refusal(400, 'This teardrop is too old to submit. Run `teardrop update`: submissions are now made from what your site recorded, with no logs uploaded.')
	}
	const key = typeof body.project === 'string' ? body.project.trim() : ''
	if (!key || key.length > 500) throw new Refusal(400, 'Name the project to submit by its key, such as github.com/you/repo.')
	const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || null : null
	// Records still in the hub's working copy go to R2 first, so the newest count.
	await env.HUB.get(env.HUB.idFromName(String(user.id))).flush()
	const { recs, days } = await projectRecords(env, user.id, key)
	if (!recs.length) throw new Refusal(404, `Your site has no records of ${key}. Its time counts once your harness's hooks send them, as you work.`)
	const { witnessed, unwitnessed } = stretches(recs)
	// What earlier submissions of the project covered is not credited again.
	const { results: earlierRows } = await env.DB.prepare('SELECT snapshot_key FROM submissions WHERE user_id = ? AND project_key = ?').bind(user.id, key).all<{ snapshot_key: string }>()
	const earlier: Span[] = [], listed: Span[] = []
	for (const row of earlierRows) {
		const obj = await env.REPORTS.get(row.snapshot_key)
		if (!obj) continue
		const old = JSON.parse(await gunzip(obj)) as Snapshot
		earlier.push(...(old.witnessed ?? []))
		listed.push(...(old.commit_gaps ?? []).map((g) => [g.start, g.end] as Span))
	}
	const covered = merge(earlier)
	const uncapped = minus(witnessed, covered)
	// Payable caps, per day and week of the person's own, across every submission they made that wasn't rejected.
	const daily = capOf(env.DAILY_CAP_HOURS), weekly = capOf(env.WEEKLY_CAP_HOURS)
	let credited = uncapped
	if (daily < Infinity || weekly < Infinity) {
		const { results: mine } = await env.DB.prepare(`SELECT snapshot_key FROM submissions WHERE user_id = ? AND state != 'rejected'`).bind(user.id).all<{ snapshot_key: string }>()
		const used: Span[] = []
		for (const row of mine) {
			const obj = await env.REPORTS.get(row.snapshot_key)
			if (!obj) continue
			const old = JSON.parse(await gunzip(obj)) as Snapshot
			used.push(...(old.credited ?? minus(merge(old.witnessed ?? []), merge(old.earlier ?? []))))
		}
		const offset = (recs.at(-1) as { offset?: number } | undefined)?.offset ?? 0
		credited = merge(capSpans(uncapped, used, offset, daily, weekly))
	}
	const id = 'sub-' + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
	const git = (await projectCommits(env, user.id)).get(key)?.commits ?? []
	const found = new Set(git.filter((c) => c.found === true && !moved(c)).map((c) => c.sha))
	const commit_gaps = commitGaps(merge([...witnessed, ...unwitnessed]), recs, found, listed)
	const snapshot: Snapshot = { project: { key, name: nameOf(key) }, days, witnessed, unwitnessed, earlier: covered, credited, commit_gaps }
	const snapshotKey = `${user.id}/submissions/${id}.json.gz`
	await env.REPORTS.put(snapshotKey, await gzip(JSON.stringify(snapshot)))
	const row: SubmissionRow = {
		id, user_id: user.id, project_key: key, project_name: nameOf(key), received_at: Date.now(),
		witnessed_seconds: seconds(witnessed), unwitnessed_seconds: seconds(unwitnessed),
		earlier_overlap_seconds: seconds(witnessed) - seconds(uncapped), credited_seconds: seconds(credited), accepted_seconds: 0,
		capped_seconds: seconds(uncapped) - seconds(credited), gap_seconds: 0, final_seconds: null,
		prompts: recs.filter((r) => r.human && !r.sha).length, tokens_in: recs.reduce((n, r) => n + (r.in ?? 0), 0), tokens_out: recs.reduce((n, r) => n + (r.out ?? 0), 0),
		state: 'pending', decided_by: null, decided_at: null, note: null, submitter_note: note, snapshot_key: snapshotKey, imported: 0,
	}
	await env.DB.prepare(
		`INSERT INTO submissions (id, user_id, project_key, project_name, received_at, witnessed_seconds, unwitnessed_seconds, earlier_overlap_seconds,
			credited_seconds, accepted_seconds, capped_seconds, prompts, tokens_in, tokens_out, state, snapshot_key, submitter_note)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'pending', ?, ?)`,
	)
		.bind(id, user.id, key, row.project_name, row.received_at, row.witnessed_seconds, row.unwitnessed_seconds, row.earlier_overlap_seconds, row.credited_seconds, row.capped_seconds, row.prompts, row.tokens_in, row.tokens_out, snapshotKey, note)
		.run()
	return row
}

/**
 * ownSubmissions is a person's own submissions, newest first: what each
 * credited, what a reviewer accepted and why, and when. Who decided stays
 * with the reviewers.
 */
export async function ownSubmissions(env: Env, userID: number) {
	const { results } = await env.DB.prepare(
		`SELECT id, project_key, project_name, received_at, witnessed_seconds, unwitnessed_seconds, earlier_overlap_seconds, credited_seconds,
			-- To the person, time accepted for gaps with commits is time accepted by hand too.
			accepted_seconds + gap_seconds AS accepted_seconds, capped_seconds, final_seconds, prompts, state, decided_at, note, submitter_note, imported
		 FROM submissions WHERE user_id = ? ORDER BY received_at DESC LIMIT 200`,
	)
		.bind(userID)
		.all()
	return results
}

/** listSubmissions is the review app's list, newest first. A reviewer sees project names only. */
export async function listSubmissions(env: Env, level: number) {
	const { results } = await env.DB.prepare(
		`SELECT s.*, u.name, u.slack_id, u.handle FROM submissions s JOIN users u ON u.id = s.user_id ORDER BY s.received_at DESC LIMIT 500`,
	).all<SubmissionRow & { name: string; slack_id: string; handle: string }>()
	return results.map((r) => (level === 2 ? { ...r, project_key: undefined } : r))
}

/** submission is one submission for its review page: its row, every record behind it, and its flags. */
export async function submission(env: Env, id: string, level: number) {
	const row = await env.DB.prepare('SELECT s.*, u.name, u.slack_id, u.handle FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
		.bind(id)
		.first<SubmissionRow & { name: string; slack_id: string; handle: string }>()
	if (!row) throw new Refusal(404, 'No such submission.')
	const obj = await env.REPORTS.get(row.snapshot_key)
	const snapshot = obj ? (JSON.parse(await gunzip(obj)) as Snapshot) : null
	const recs: Kept[] = []
	for (const d of snapshot?.days ?? []) {
		const day = await env.REPORTS.get(d.key)
		if (!day) continue
		for (const line of (await gunzip(day)).split('\n')) {
			if (!line) continue
			const r = JSON.parse(line) as Kept
			if (r.project === row.project_key) recs.push(r)
		}
	}
	recs.sort((a, b) => a.t - b.t)
	const days = snapshot?.days.map((d) => d.day) ?? []
	const { results: dayTotals } = days.length
		? await env.DB.prepare(`SELECT day, witnessed_seconds FROM prompt_days WHERE user_id = ? AND computer_id = '' AND day IN (SELECT value FROM json_each(?))`)
				.bind(row.user_id, JSON.stringify(days))
				.all<{ day: string; witnessed_seconds: number }>()
		: { results: [] }
	// Computers are numbered, not named, for a reviewer.
	const computers = [...new Set(recs.map((r) => r.computer))]
	return {
		submission: level === 2 ? { ...row, project_key: undefined } : row,
		witnessed: snapshot?.witnessed ?? [],
		unwitnessed: snapshot?.unwitnessed ?? [],
		earlier: snapshot?.earlier ?? [],
		commit_gaps: snapshot?.commit_gaps ?? [],
		days: snapshot?.days ?? [],
		flags: flags(recs, dayTotals),
		records: recs.map((r) => ({
			t: r.t, late_ms: r.arrived - r.t, tool: r.tool, event: r.event, session: r.session, human: r.human,
			computer: level === 2 ? `computer ${computers.indexOf(r.computer) + 1}` : r.computer,
			judged: r.judged, real: r.real, low: r.low, repeat_print: r.sim, in: r.in, out: r.out, added: r.added, removed: r.removed, sha: r.sha,
		})),
	}
}

export type Action = 'approve' | 'adjust' | 'reject'

/**
 * decide settles a submission, with a note kept in the staff log:
 *
 *   approve credits what was witnessed, plus any unwitnessed time accepted
 *     and any time accepted for gaps with commits, each up to its most.
 *   adjust sets what it finally credits, at most witnessed plus unwitnessed.
 *   reject credits nothing.
 *
 * A reviewer may approve or reject a pending submission. Accepting
 * unwitnessed time, adjusting, and deciding again take a neoadmin. A rejected
 * submission still covers its time, so submitting the project again can't
 * credit it.
 */
export async function decide(env: Env, actor: User, id: string, body: Record<string, unknown>): Promise<void> {
	const row = await env.DB.prepare('SELECT s.state, s.credited_seconds, s.unwitnessed_seconds, s.snapshot_key, u.slack_id FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
		.bind(id)
		.first<{ state: string; credited_seconds: number; unwitnessed_seconds: number; snapshot_key: string; slack_id: string }>()
	if (!row) throw new Refusal(404, 'No such submission.')
	const action = body.action as Action
	if (!['approve', 'adjust', 'reject'].includes(action)) throw new Refusal(400, 'Say whether to approve, adjust, or reject it.')
	const secs = body.seconds == null || body.seconds === '' ? 0 : Number(body.seconds)
	const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : ''
	if (!Number.isInteger(secs) || secs < 0) throw new Refusal(400, 'Give the seconds as a whole number.')
	if (!note) throw new Refusal(400, 'Say why, in a note: the person reads it, and it is kept with the decision.')
	const most = row.credited_seconds + row.unwitnessed_seconds
	if (action === 'adjust' && secs > most) throw new Refusal(400, `It can credit at most ${most} seconds: what was witnessed, less earlier submissions, plus what was unwitnessed.`)
	const accepted = action === 'approve' ? Math.min(secs, row.unwitnessed_seconds) : action === 'adjust' ? Math.max(0, secs - row.credited_seconds) : 0
	// Approving may also accept time for gaps with commits, each up to its most.
	let gapped = 0
	const asked = Array.isArray(body.gaps) ? body.gaps.map(Number) : []
	if (asked.some((n) => !Number.isInteger(n) || n < 0)) throw new Refusal(400, 'Give the seconds for each gap as a whole number.')
	if (action === 'approve' && asked.some((n) => n > 0)) {
		const obj = await env.REPORTS.get(row.snapshot_key)
		const gaps = obj ? ((JSON.parse(await gunzip(obj)) as Snapshot).commit_gaps ?? []) : []
		asked.forEach((n, i) => (gapped += Math.min(n, gaps[i]?.most ?? 0)))
	}
	const final = action === 'approve' ? row.credited_seconds + accepted + gapped : action === 'adjust' ? secs : 0
	if (actor.level === 2) {
		if (row.state !== 'pending') throw new Refusal(403, 'It is already decided. A neoadmin can decide it again.')
		if (action === 'adjust' || accepted > 0 || gapped > 0) throw new Refusal(403, 'Only a neoadmin can accept unwitnessed time, accept gaps with commits, or adjust a submission.')
	}
	const state = { approve: 'approved', adjust: 'adjusted', reject: 'rejected' }[action]
	const now = Date.now()
	await env.DB.batch([
		env.DB.prepare(`UPDATE submissions SET accepted_seconds = ?, gap_seconds = ?, final_seconds = ?, state = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?`)
			.bind(accepted, gapped, final, state, actor.slack_id, now, note, id),
		env.DB.prepare('INSERT INTO staff_log (at, by_slack_id, action, slack_id, detail) VALUES (?, ?, ?, ?, ?)')
			.bind(now, actor.slack_id, action, row.slack_id, `${id}: ${state}, ${final}s credited (${accepted}s unwitnessed and ${gapped}s of gaps with commits accepted). ${note}`),
	])
}

/** An old review server's record.json line, as `teardrop export-records` prints it. */
interface OldRecord {
	id?: unknown
	account?: unknown
	project?: { key?: unknown; name?: unknown }
	received_at?: unknown
	engaged?: { start: string; end: string }[]
	credited_seconds?: unknown
}

/**
 * importRecords copies what the retired review server credited into
 * submissions, marked imported, so a project is never credited twice. Each
 * record's computer names its account. It returns how many were added and
 * which records name a computer no account has.
 */
export async function importRecords(env: Env, body: string): Promise<{ imported: number; unknown: string[] }> {
	let imported = 0
	const unknown: string[] = []
	for (const line of body.split('\n')) {
		if (!line.trim()) continue
		let r: OldRecord
		try {
			r = JSON.parse(line)
		} catch {
			throw new Refusal(400, 'Each line must be one record from `teardrop export-records`.')
		}
		const id = typeof r.id === 'string' ? r.id : ''
		const account = typeof r.account === 'string' ? r.account : ''
		const key = typeof r.project?.key === 'string' ? r.project.key : ''
		if (!id || !key) throw new Refusal(400, 'A record has no id or project.')
		const owner = await env.DB.prepare('SELECT user_id FROM computers WHERE id = ?').bind(account).first<{ user_id: number }>()
		if (!owner) {
			unknown.push(id)
			continue
		}
		const witnessed: Span[] = (r.engaged ?? []).map((e) => [Date.parse(e.start), Date.parse(e.end)] as Span).filter(([s, e]) => e > s)
		const snapshotKey = `${owner.user_id}/submissions/old-${id}.json.gz`
		const snapshot: Snapshot = { project: { key, name: typeof r.project?.name === 'string' ? r.project.name : nameOf(key) }, days: [], witnessed: merge(witnessed), unwitnessed: [], earlier: [] }
		await env.REPORTS.put(snapshotKey, await gzip(JSON.stringify(snapshot)))
		const credited = Number(r.credited_seconds) || 0
		const done = await env.DB.prepare(
			`INSERT OR IGNORE INTO submissions (id, user_id, project_key, project_name, received_at, witnessed_seconds, unwitnessed_seconds, earlier_overlap_seconds,
				credited_seconds, final_seconds, prompts, state, snapshot_key, imported)
			 VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 'approved', ?, 1)`,
		)
			.bind('old-' + id, owner.user_id, key, snapshot.project.name, Date.parse(String(r.received_at)) || Date.now(), seconds(witnessed), credited, credited, snapshotKey)
			.run()
		imported += done.meta.changes
	}
	return { imported, unknown }
}
