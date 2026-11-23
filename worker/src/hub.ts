// UserHub: one Durable Object per account, which takes every prompt and turn
// record the person's harnesses send, as they happen. It stamps when each one
// arrived, drops repeats, and keeps a working copy of the days that are not
// sealed. Within FLUSH of a record arriving it writes each changed day to R2,
// where records are kept for good, one compressed file per person per day,
// and puts that day's totals in D1 (prompt_days). A day is sealed SEAL after
// it ends; a record for a sealed day reads the day back from R2 first.
// Records never hold prompt or reply text.
import { DurableObject } from 'cloudflare:workers'
import type { User } from './auth.ts'
import { type Commit, remember } from './git.ts'
import { Refusal } from './http.ts'
import { refreshRecordComputer } from './reports.ts'
import { makeSubmission, type SubmissionRow } from './submissions.ts'
import { blocks, type Clock, corrected, nextClock, RULES, type Rec, timed, totals, WATCH } from './timeline.ts'

const FLUSH = 10 * 60_000
const SEAL = 48 * 3600_000
const DAY = 86400_000
/** How far ahead of this clock a record may say it happened. */
const CLOCK_SKEW = 5 * 60_000
/** The longest one record's line may be. */
const MAX_LINE = 2000

/** A record as a client sends it, one JSON object per line. */
interface Line {
	t?: unknown
	tool?: unknown
	event?: unknown
	session?: unknown
	human?: unknown
	judged?: unknown
	real?: unknown
	low?: unknown
	in?: unknown
	out?: unknown
	added?: unknown
	removed?: unknown
	cwd?: unknown
	git?: unknown
	project?: unknown
	sha?: unknown
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 1e12) : 0)
/** The most tokens and lines one record may claim. More is cut to this, and the record is marked. */
export const MAX_TOKENS = 200_000_000
export const MAX_LINES = 1_000_000
/** A setting from wrangler.jsonc, as a positive number, else fallback. */
const setting = (v: string | undefined, fallback: number) => (Number(v) > 0 ? Number(v) : fallback)
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** dayOf returns the calendar day a time falls on, at a UTC offset in minutes. */
export const dayOf = (t: number, offset: number) => new Date(t + offset * 60_000).toISOString().slice(0, 10)

/** The R2 name of one person's records of one day. */
export const dayKey = (userID: number, day: string) => `${userID}/prompts/${day.slice(0, 4)}/${day.slice(5)}.ndjson.gz`

/** What an open dashboard or profile shows live: whether the person is at it now, and today's totals. */
export interface Live {
	working: { tool: string; project?: string; since: number; kind: 'prompt' | 'agent' } | null
	today: { day: string; witnessed_seconds: number; unwitnessed_seconds: number; prompts: number }
}

export class UserHub extends DurableObject<Env> {
	/** Uploads left in this account's burst, and when it was last topped up. Kept in memory only. */
	private uploads = NaN
	private uploadsAt = 0

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.schema()
	}

	private schema() {
		const ctx = this.ctx
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS recs (
			computer TEXT NOT NULL, tool TEXT NOT NULL, session TEXT NOT NULL, event TEXT NOT NULL, t INTEGER NOT NULL,
			arrived INTEGER NOT NULL, day TEXT NOT NULL, rec TEXT NOT NULL,
			PRIMARY KEY (computer, tool, session, event, t))`)
		ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS recs_day ON recs (day)')
		// Days with records not yet in R2, and days read back from R2 for a late record.
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS dirty (day TEXT PRIMARY KEY)')
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS loaded (day TEXT PRIMARY KEY)')
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
	}

	/**
	 * add keeps the records in lines, sent from computer, whose clock is
	 * offset minutes ahead of UTC. It returns how many were new, and how many
	 * it refused for a time ahead of this clock, which a computer whose clock
	 * runs fast sends. Lines that are not a record are left out.
	 *
	 * reading is how far the computer's clock runs behind this one, as
	 * measured on this batch, or null; it moves the computer's pinned
	 * correction only as nextClock allows, and the pin, not the reading,
	 * corrects the future check and is kept on each record for witnessing.
	 *
	 * Past the account's limits it stops and returns limited: what it to say,
	 * and in how many seconds to try again. What it kept before then stays;
	 * the client sends the batch again, and the site drops the repeats.
	 */
	async add(
		userID: number,
		computer: string,
		offset: number,
		lines: string[],
		reading: number | null = null,
	): Promise<{ stored: number; future: number; records: Rec[]; limited?: { message: string; retryAfter: number } }> {
		const sql = this.ctx.storage.sql
		sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('user', ?)`, String(userID))
		const now = Date.now()
		const kept: Rec[] = []
		let future = 0

		const burst = setting(this.env.UPLOAD_BURST, 1000)
		if (Number.isNaN(this.uploads)) this.uploads = burst
		this.uploads = Math.min(burst, this.uploads + (now - this.uploadsAt) / 1000)
		this.uploadsAt = now
		if (this.uploads < 1) {
			return { stored: 0, future: 0, records: [], limited: { message: 'This account is sending too many uploads at once. teardrop sends the rest in a moment.', retryAfter: Math.ceil(1 - this.uploads) } }
		}
		this.uploads--
		// Records a UTC day, recent and old, counted as they are written.
		const today = new Date(now).toISOString().slice(0, 10)
		const caps = { recent: setting(this.env.RECENT_RECORDS_PER_DAY, 30_000), old: setting(this.env.OLD_RECORDS_PER_DAY, 1_000_000) }
		const used = { recent: 0, old: 0 }
		for (const kind of ['recent', 'old'] as const) used[kind] = Number(sql.exec('SELECT v FROM meta WHERE k = ?', `${kind}:${today}`).toArray()[0]?.v ?? 0)
		sql.exec(`DELETE FROM meta WHERE (k LIKE 'recent:%' OR k LIKE 'old:%') AND k NOT IN (?, ?)`, `recent:${today}`, `old:${today}`)
		let limited: { message: string; retryAfter: number } | undefined
		// Cloud records carry the cloud machine's times, not the sender's, so only a computer's own are corrected.
		let skew = 0
		if (computer !== 'cloud') {
			const key = `clock:${computer}`
			const was = sql.exec('SELECT v FROM meta WHERE k = ?', key).toArray()[0]?.v
			const clock = nextClock(was ? (JSON.parse(String(was)) as Clock) : null, reading, now)
			if (clock) {
				sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', key, JSON.stringify(clock))
				skew = clock.pin
			}
		}

		for (const line of lines) {
			if (!line.trim() || line.length > MAX_LINE) continue
			let ev: Line
			try {
				ev = JSON.parse(line)
			} catch {
				continue
			}
			const t = typeof ev?.t === 'string' ? Date.parse(ev.t) : NaN
			const tool = text(ev.tool, 32), session = text(ev.session, 200), event = text(ev.event, 64)
			if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(tool) || !session || !event || !(t > 0)) continue
			if (t + corrected(skew) > now + CLOCK_SKEW) {
				future++
				continue
			}
			// The fingerprint is a 64-bit number: read from the text, so it is never rounded.
			const sim = /"sim":\s*"?(\d{1,20})/.exec(line)?.[1]
			const [tin, tout, added, removed] = [count(ev.in), count(ev.out), count(ev.added), count(ev.removed)]
			const clamped = tin > MAX_TOKENS || tout > MAX_TOKENS || added > MAX_LINES || removed > MAX_LINES
			const rec: Rec = {
				t, arrived: now, tool, session, event, human: ev.human === true && event !== 'usage',
				project: text(ev.project, 500) || text(ev.git, 500) || text(ev.cwd, 500),
				...(ev.human === true ? { judged: count(ev.judged), real: count(ev.real), low: ev.low === true, ...(sim && sim !== '0' ? { sim } : {}) } : {}),
				...(tin || tout ? { in: Math.min(tin, MAX_TOKENS), out: Math.min(tout, MAX_TOKENS) } : {}),
				...(added || removed ? { added: Math.min(added, MAX_LINES), removed: Math.min(removed, MAX_LINES) } : {}),
				...(clamped ? { clamped: true } : {}),
				...(Math.abs(skew) >= 1000 ? { skew } : {}),
				...(event === 'commit' && typeof ev.sha === 'string' && /^[0-9a-f]{40}$/.test(ev.sha) ? { sha: ev.sha } : {}),
			}
			if (event === 'commit' && !rec.sha) continue
			const kind = now - t <= SEAL ? 'recent' : 'old'
			if (used[kind] >= caps[kind]) {
				const midnight = Date.parse(today) + DAY
				limited = {
					message: `This account sent ${caps[kind].toLocaleString('en-US')} ${kind === 'recent' ? 'records from the last two days' : 'older records'} today, the most a day takes. The rest wait on your computer until midnight UTC.`,
					retryAfter: Math.ceil((midnight - now) / 1000),
				}
				break
			}
			const day = dayOf(t, offset)
			if (now - (Date.parse(day) + DAY - offset * 60_000) > SEAL) await this.load(userID, day)
			// A turn's usage, from its transcript, is sent again as the turn grows, and the latest counts.
			const done = sql.exec(`INSERT OR ${event === 'usage' ? 'REPLACE' : 'IGNORE'} INTO recs (computer, tool, session, event, t, arrived, day, rec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				computer, tool, session, event, t, now, day, JSON.stringify({ ...rec, computer, event, offset }))
			if (done.rowsWritten) {
				sql.exec('INSERT OR IGNORE INTO dirty (day) VALUES (?)', day)
				kept.push(rec)
				used[kind]++
			}
		}
		for (const kind of ['recent', 'old'] as const) {
			if (used[kind]) sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', `${kind}:${today}`, String(used[kind]))
		}
		if (kept.length && (await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(now + FLUSH)
		// Open dashboards hear of it at once; a send never waits on the socket.
		if (kept.length) this.broadcast()
		return { stored: kept.length, future, records: kept, ...(limited ? { limited } : {}) }
	}

	/** load reads a sealed day's records back from R2 into the working copy, once. */
	private async load(userID: number, day: string) {
		const sql = this.ctx.storage.sql
		if (sql.exec('SELECT 1 FROM loaded WHERE day = ?', day).toArray().length) return
		sql.exec('INSERT INTO loaded (day) VALUES (?)', day)
		const obj = await this.env.REPORTS.get(dayKey(userID, day))
		if (!obj) return
		const body = await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text()
		for (const line of body.split('\n')) {
			if (!line) continue
			const r = JSON.parse(line) as Rec & { computer: string; event: string }
			sql.exec(`INSERT OR IGNORE INTO recs (computer, tool, session, event, t, arrived, day, rec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, r.computer, r.tool, r.session, r.event, r.t, r.arrived, day, line)
		}
	}

	async alarm() {
		await this.flush()
	}

	/**
	 * submit makes one of the person's submissions, with nothing else running
	 * in this hub meanwhile: no other submission, and no record arriving
	 * between writing the working copy to R2 and reading it back. A refusal
	 * is returned, since an error loses its status on the way back.
	 */
	async submit(user: User, body: Record<string, unknown>): Promise<{ row?: SubmissionRow; refused?: { status: number; message: string } }> {
		return this.ctx.blockConcurrencyWhile(async () => {
			await this.flush()
			try {
				return { row: await makeSubmission(this.env, user, body) }
			} catch (e) {
				if (e instanceof Refusal) return { refused: { status: e.status, message: e.message } }
				throw e
			}
		})
	}

	/**
	 * flush writes every changed day to R2 and its totals to D1, then forgets
	 * the working copy of sealed days. It returns the days it wrote.
	 */
	async flush(): Promise<string[]> {
		const sql = this.ctx.storage.sql
		const user = Number(sql.exec(`SELECT v FROM meta WHERE k = 'user'`).toArray()[0]?.v)
		const days = sql.exec('SELECT day FROM dirty ORDER BY day').toArray().map((r) => String(r.day))
		if (!user) return []
		for (const day of days) {
			const lines = sql.exec('SELECT rec FROM recs WHERE day = ? ORDER BY t, computer, tool, session, event', day).toArray().map((r) => String(r.rec))
			const body = lines.join('\n') + '\n'
			const gzip = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
			await this.env.REPORTS.put(dayKey(user, day), gzip)
			const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')
			const recs = lines.map((l) => JSON.parse(l) as Rec & { computer: string; offset: number })
			const offset = recs[0]?.offset ?? 0
			const from = Date.parse(day) - offset * 60_000
			const rows: [string, Rec[]][] = [['', recs]]
			for (const c of new Set(recs.map((r) => r.computer))) rows.push([c, recs.filter((r) => r.computer === c)])
			const now = Date.now()
			await this.env.DB.batch(
				rows.map(([computer, list]) => {
					const s = totals(list, from, from + DAY)
					const projects = Object.fromEntries(Object.entries(s.projects).map(([k, p]) => [k, [Math.round(p.witnessed / 1000), Math.round(p.unwitnessed / 1000), p.prompts]]))
					// A computer's work blocks, for the dashboard and review graphs: [start, end, engaged s, prompts, in, out, added, removed, project, tools].
					const day_blocks = computer ? blocks(list, from, from + DAY).map((b) => [b.start, b.end, Math.round(b.engaged / 1000), b.prompts, b.in, b.out, b.added, b.removed, b.project, b.tools.join(',')]) : []
					return this.env.DB.prepare(
						`INSERT INTO prompt_days (user_id, computer_id, day, witnessed_seconds, unwitnessed_seconds, prompts, tokens_in, tokens_out, lines_added, lines_removed, projects, sha256, rules, updated_at, blocks)
						 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
						 ON CONFLICT (user_id, computer_id, day) DO UPDATE SET witnessed_seconds = ?4, unwitnessed_seconds = ?5, prompts = ?6, tokens_in = ?7,
							tokens_out = ?8, lines_added = ?9, lines_removed = ?10, projects = ?11, sha256 = ?12, rules = ?13, updated_at = ?14, blocks = ?15`,
					).bind(user, computer, day, Math.round(s.witnessed / 1000), Math.round(s.unwitnessed / 1000), s.prompts, s.tokens_in, s.tokens_out, s.lines_added, s.lines_removed, JSON.stringify(projects), computer ? '' : hash, RULES, now, JSON.stringify(day_blocks))
				}),
			)
			// Commits go to their project's row, for links and the GitHub check.
			const commits = new Map<string, Commit[]>()
			for (const r of recs) if (r.sha) commits.set(r.project, [...(commits.get(r.project) ?? []), { sha: r.sha, t: r.t, added: r.added ?? 0, removed: r.removed ?? 0, seen: r.arrived }])
			for (const [project, list] of commits) await remember(this.env, user, project, list)
			sql.exec('DELETE FROM dirty WHERE day = ?', day)
		}
		// The computers the days came from show their new totals on the dashboard and in the review app.
		const touched = new Set<string>()
		for (const day of days) for (const r of sql.exec('SELECT DISTINCT computer FROM recs WHERE day = ?', day).toArray()) touched.add(String(r.computer))
		for (const c of touched) await refreshRecordComputer(this.env, user, c)
		// Sealed days live in R2 alone from here on.
		const sealed = dayOf(Date.now() - SEAL - DAY, 0)
		sql.exec('DELETE FROM recs WHERE day < ? AND day NOT IN (SELECT day FROM dirty)', sealed)
		sql.exec('DELETE FROM loaded WHERE day NOT IN (SELECT DISTINCT day FROM recs)')
		return days
	}

	/** records returns the working copy's records from one time on, for live views and submissions of recent days. */
	async records(from: number): Promise<(Rec & { computer: string })[]> {
		return this.ctx.storage.sql.exec('SELECT rec FROM recs WHERE t >= ? ORDER BY t', from).toArray().map((r) => JSON.parse(String(r.rec)))
	}

	/**
	 * live works out what a dashboard shows from the working copy: the latest
	 * record, if it is recent, and today's totals on the person's latest clock.
	 */
	live(now = Date.now()): Live {
		const recs = this.ctx.storage.sql.exec('SELECT rec FROM recs WHERE t >= ? ORDER BY t', now - 2 * DAY).toArray().map((r) => JSON.parse(String(r.rec)) as Rec & { offset: number }).filter(timed)
		const last = recs.at(-1)
		const offset = last?.offset ?? 0
		const day = dayOf(now, offset)
		const from = Date.parse(day) - offset * 60_000
		const s = totals(recs.filter((r) => r.t >= from - WATCH), from, from + DAY)
		return {
			working: last && now - last.t < WATCH ? { tool: last.tool, project: last.project, since: last.t, kind: last.human ? 'prompt' : 'agent' } : null,
			today: { day, witnessed_seconds: Math.round(s.witnessed / 1000), unwitnessed_seconds: Math.round(s.unwitnessed / 1000), prompts: s.prompts },
		}
	}

	/** view is what one kind of socket is sent: a profile's visitors never learn the project. */
	private view(tag: string): Live {
		const l = this.live()
		return tag === 'owner' || !l.working ? l : { ...l, working: { tool: l.working.tool, since: l.working.since, kind: l.working.kind } }
	}

	private broadcast() {
		for (const tag of ['owner', 'public']) {
			const sockets = this.ctx.getWebSockets(tag)
			if (!sockets.length) continue
			const msg = JSON.stringify(this.view(tag))
			for (const ws of sockets) {
				try {
					ws.send(msg)
				} catch {}
			}
		}
	}

	/**
	 * fetch takes a WebSocket for a live view. The Worker has checked who may
	 * have one, and says which with X-Live: owner, or public for a profile.
	 * Sockets hibernate between messages, so an idle one costs nothing.
	 */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') return Response.json(this.view(request.headers.get('X-Live') ?? 'public'))
		const tag = request.headers.get('X-Live') === 'owner' ? 'owner' : 'public'
		const [client, server] = Object.values(new WebSocketPair())
		this.ctx.acceptWebSocket(server!, [tag])
		server!.send(JSON.stringify(this.view(tag)))
		return new Response(null, { status: 101, webSocket: client })
	}

	webSocketMessage(ws: WebSocket) {
		// Anything a page sends asks for the current state, such as after it wakes.
		ws.send(JSON.stringify(this.view(this.ctx.getTags(ws)[0] ?? 'public')))
	}

	webSocketClose(ws: WebSocket, code: number) {
		try {
			ws.close(code)
		} catch {}
	}

	/** forget empties the hub, when its person deletes their account. */
	async forget() {
		await this.ctx.storage.deleteAlarm()
		await this.ctx.storage.deleteAll()
		this.schema()
	}
}
