// Project submissions. A submission is a snapshot of records the site already
// holds: the project's time across the person's computers, split into what
// the site witnessed (records that reached it within 5 minutes of the time
// they claim) and what it didn't. Only witnessed time is credited, less what
// earlier submissions of the project covered. A neoadmin may accept
// unwitnessed time by hand. Nothing is uploaded with a submission, and no
// prompt text is ever on the site.
import type { User } from './auth.ts'
import { dayKey } from './hub.ts'
import { Refusal } from './http.ts'
import { credit, flags, type Rec, type Stretch } from './timeline.ts'

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
	prompts: number
	tokens_in: number
	tokens_out: number
	state: string
	decided_by: string | null
	decided_at: number | null
	note: string | null
	snapshot_key: string
	imported: number
}

interface Snapshot {
	project: { key: string; name: string }
	days: { day: string; key: string; sha256: string }[]
	witnessed: Span[]
	unwitnessed: Span[]
	earlier: Span[]
}

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

/** submit makes a submission of one of the person's projects from the records the site holds. */
export async function submit(env: Env, user: User, body: Record<string, unknown>): Promise<SubmissionRow> {
	if ('signed' in body || 'logs' in body) {
		throw new Refusal(400, 'This teardrop is too old to submit. Run `teardrop update`: submissions are now made from what your site recorded, with no logs uploaded.')
	}
	const key = typeof body.project === 'string' ? body.project.trim() : ''
	if (!key || key.length > 500) throw new Refusal(400, 'Name the project to submit by its key, such as github.com/you/repo.')
	// Records still in the hub's working copy go to R2 first, so the newest count.
	await env.HUB.get(env.HUB.idFromName(String(user.id))).flush()
	const { recs, days } = await projectRecords(env, user.id, key)
	if (!recs.length) throw new Refusal(404, `Your site has no records of ${key}. Its time counts once your harness's hooks send them, as you work.`)
	const { witnessed, unwitnessed } = stretches(recs)
	// What earlier submissions of the project covered is not credited again.
	const { results: earlierRows } = await env.DB.prepare('SELECT snapshot_key FROM submissions WHERE user_id = ? AND project_key = ?').bind(user.id, key).all<{ snapshot_key: string }>()
	const earlier: Span[] = []
	for (const row of earlierRows) {
		const obj = await env.REPORTS.get(row.snapshot_key)
		if (obj) earlier.push(...((JSON.parse(await gunzip(obj)) as Snapshot).witnessed ?? []))
	}
	const covered = merge(earlier)
	const credited = minus(witnessed, covered)
	const id = 'sub-' + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
	const snapshot: Snapshot = { project: { key, name: nameOf(key) }, days, witnessed, unwitnessed, earlier: covered }
	const snapshotKey = `${user.id}/submissions/${id}.json.gz`
	await env.REPORTS.put(snapshotKey, await gzip(JSON.stringify(snapshot)))
	const row: SubmissionRow = {
		id, user_id: user.id, project_key: key, project_name: nameOf(key), received_at: Date.now(),
		witnessed_seconds: seconds(witnessed), unwitnessed_seconds: seconds(unwitnessed),
		earlier_overlap_seconds: seconds(witnessed) - seconds(credited), credited_seconds: seconds(credited), accepted_seconds: 0,
		prompts: recs.filter((r) => r.human && !r.sha).length, tokens_in: recs.reduce((n, r) => n + (r.in ?? 0), 0), tokens_out: recs.reduce((n, r) => n + (r.out ?? 0), 0),
		state: 'pending', decided_by: null, decided_at: null, note: null, snapshot_key: snapshotKey, imported: 0,
	}
	await env.DB.prepare(
		`INSERT INTO submissions (id, user_id, project_key, project_name, received_at, witnessed_seconds, unwitnessed_seconds, earlier_overlap_seconds,
			credited_seconds, accepted_seconds, prompts, tokens_in, tokens_out, state, snapshot_key)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'pending', ?)`,
	)
		.bind(id, user.id, key, row.project_name, row.received_at, row.witnessed_seconds, row.unwitnessed_seconds, row.earlier_overlap_seconds, row.credited_seconds, row.prompts, row.tokens_in, row.tokens_out, snapshotKey)
		.run()
	return row
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
		days: snapshot?.days ?? [],
		flags: flags(recs, dayTotals),
		records: recs.map((r) => ({
			t: r.t, late_ms: r.arrived - r.t, tool: r.tool, event: r.event, session: r.session, human: r.human,
			computer: level === 2 ? `computer ${computers.indexOf(r.computer) + 1}` : r.computer,
			judged: r.judged, real: r.real, low: r.low, repeat_print: r.sim, in: r.in, out: r.out, added: r.added, removed: r.removed, sha: r.sha,
		})),
	}
}

/** accept credits unwitnessed time of a submission by hand, which a neoadmin or superadmin may do, with a note. */
export async function accept(env: Env, actor: User, id: string, body: Record<string, unknown>): Promise<void> {
	const row = await env.DB.prepare('SELECT s.user_id, s.unwitnessed_seconds, u.slack_id FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
		.bind(id)
		.first<{ user_id: number; unwitnessed_seconds: number; slack_id: string }>()
	if (!row) throw new Refusal(404, 'No such submission.')
	const secs = Number(body.seconds)
	const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : ''
	if (!Number.isInteger(secs) || secs < 0) throw new Refusal(400, 'Say how many seconds of unwitnessed time to accept, as a whole number.')
	if (!note) throw new Refusal(400, 'Say why, in a note: it is kept with the change.')
	const accepted = Math.min(secs, row.unwitnessed_seconds)
	const now = Date.now()
	await env.DB.batch([
		env.DB.prepare(`UPDATE submissions SET accepted_seconds = ?, state = 'decided', decided_by = ?, decided_at = ?, note = ? WHERE id = ?`).bind(accepted, actor.slack_id, now, note, id),
		env.DB.prepare('INSERT INTO staff_log (at, by_slack_id, action, slack_id, detail) VALUES (?, ?, ?, ?, ?)').bind(now, actor.slack_id, 'accept', row.slack_id, `${id}: accepted ${accepted}s unwitnessed. ${note}`),
	])
}
