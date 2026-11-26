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
import { computerAlias, refreshRecordComputer } from './reports.ts'
import { blocks, type Clock, corrected, nextClock, nextOffset, type OffsetPin, RULES, type Rec, timed, totals, WATCH } from './timeline.ts'

const FLUSH = 10 * 60_000
const SEAL = 48 * 3600_000
const DAY = 86400_000
/** How far ahead of this clock a record may say it happened. */
const CLOCK_SKEW = 5 * 60_000
/** The longest one record's line may be. */
const MAX_LINE = 2000
/** How many visitors may watch one profile live at once. */
export const MAX_PUBLIC_SOCKETS = 50
/** How many messages a profile's visitor may send in a minute before their socket is closed. */
const PUBLIC_MESSAGES = 30
/** How long a worked-out live state is shown before it is worked out again, unless a record arrives first. */
const LIVE_FOR = 5000

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
	/** Records kept on one UTC day, recent and old: read from storage once, shared by batches at once, and written back as they grow. */
	private sent: { day: string; recent: number; old: number } | null = null
	/** The name each computer's records are kept under: its own, or a stand-in when another account holds its ID. */
	private names = new Map<string, string>()
	/** The live state last worked out, and when. */
	private shown: { at: number; live: Live } | null = null

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
		offsetSent: number | null,
		lines: string[],
		reading: number | null = null,
	): Promise<{ stored: number; future: number; records: Rec[]; limited?: { message: string; retryAfter: number } }> {
		const sql = this.ctx.storage.sql
		sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('user', ?)`, String(userID))
		const now = Date.now()
		const kept: Rec[] = []
		let future = 0

		// Uploads left in the account's burst, topped up one a second. Kept in storage, so a hub that restarts doesn't start a new burst.
		const burst = setting(this.env.UPLOAD_BURST, 1000)
		const had = sql.exec(`SELECT v FROM meta WHERE k = 'uploads'`).toArray()[0]?.v
		const bucket = had ? (JSON.parse(String(had)) as { n: number; at: number }) : { n: burst, at: now }
		const uploads = Math.min(burst, bucket.n + Math.max(0, now - bucket.at) / 1000)
		sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('uploads', ?)`, JSON.stringify({ n: uploads < 1 ? uploads : uploads - 1, at: now }))
		if (uploads < 1) {
			return { stored: 0, future: 0, records: [], limited: { message: 'This account is sending too many uploads at once. teardrop sends the rest in a moment.', retryAfter: Math.ceil(1 - uploads) } }
		}
		// A computer ID another account holds is kept under a stand-in of this account's own.
		computer = await this.named(userID, computer)
		// Days are counted at the account's pinned offset, not the batch's own.
		const pinned = sql.exec(`SELECT v FROM meta WHERE k = 'offset'`).toArray()[0]?.v
		// Only a computer's own offset can move it: a cloud machine and a batch that names none follow it.
		// Until a computer pins one, their days are UTC days, whatever offset they name: a cloud batch can't pick its own calendar.
		const was = pinned ? (JSON.parse(String(pinned)) as OffsetPin) : null
		const pin = offsetSent === null || computer === 'cloud' ? (was ?? { pin: 0 }) : nextOffset(was, offsetSent, now)
		// `seen` is kept to the hour, so a busy account doesn't write this on every batch.
		if (was && pin.seen != null && was.seen != null && pin.seen - was.seen < 3600_000) pin.seen = was.seen
		// An account whose first batch is a cloud one, or has no offset, isn't pinned yet: its first computer's offset is the one to pin.
		const unpinned = !was && (offsetSent === null || computer === 'cloud')
		if (!unpinned && JSON.stringify(pin) !== pinned) sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('offset', ?)`, JSON.stringify(pin))
		const offset = pin.pin
		// Records a UTC day, recent and old, counted as they are kept.
		const today = new Date(now).toISOString().slice(0, 10)
		const caps = { recent: setting(this.env.RECENT_RECORDS_PER_DAY, 30_000), old: setting(this.env.OLD_RECORDS_PER_DAY, 100_000) }
		// The counts are read from storage once and held by the hub, not the
		// batch, so batches at once share them. They are written back before
		// each wait and when the batch ends, not at every record.
		if (this.sent?.day !== today) {
			const stored = (kind: 'recent' | 'old') => Number(sql.exec('SELECT v FROM meta WHERE k = ?', `${kind}:${today}`).toArray()[0]?.v ?? 0)
			this.sent = { day: today, recent: stored('recent'), old: stored('old') }
			sql.exec(`DELETE FROM meta WHERE (k LIKE 'recent:%' OR k LIKE 'old:%') AND k NOT IN (?, ?)`, `recent:${today}`, `old:${today}`)
		}
		const sent = this.sent
		let counted = false
		const saveCounts = () => {
			if (!counted) return
			counted = false
			for (const kind of ['recent', 'old'] as const) sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', `${kind}:${today}`, String(sent[kind]))
		}
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
			// `null`, a number, or a list is JSON too, and no record.
			if (!ev || typeof ev !== 'object') continue
			const t = typeof ev.t === 'string' ? Date.parse(ev.t) : NaN
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
			const day = dayOf(t, offset)
			// A sealed day is read back first, and so are the sealed days either
			// side of it: sent again under another offset, the record may be in one
			// of them. They are read at once, and asked again until all three are
			// loaded together: a flush can forget a day between a read ending and
			// this going on.
			const sealed = [-2 * DAY, -DAY, 0, DAY, 2 * DAY].map((near) => dayOf(Date.parse(day) + near, 0)).filter((d) => now - (Date.parse(d) + DAY - offset * 60_000) > SEAL)
			for (let reads; (reads = sealed.map((d) => this.load(userID, d)).filter(Boolean)).length; ) {
				saveCounts()
				await Promise.all(reads)
			}
			if (sent[kind] >= caps[kind]) {
				const midnight = Date.parse(today) + DAY
				limited = {
					message: `This account sent ${caps[kind].toLocaleString('en-US')} ${kind === 'recent' ? 'records from the last two days' : 'older records'} today, the most a day takes. The rest wait on your computer until midnight UTC.`,
					retryAfter: Math.ceil((midnight - now) / 1000),
				}
				break
			}
			// A turn's usage, from its transcript, is sent again as the turn grows,
			// and the latest counts. It stays in the day it is in, and at the
			// offset that day is counted at, should the offset have moved since.
			const was = event === 'usage' ? sql.exec(`SELECT day, rec ->> 'offset' AS offset FROM recs WHERE computer = ? AND tool = ? AND session = ? AND event = ? AND t = ?`, computer, tool, session, event, t).toArray()[0] : undefined
			const at = was ? String(was.day) : day
			const done = sql.exec(`INSERT OR ${event === 'usage' ? 'REPLACE' : 'IGNORE'} INTO recs (computer, tool, session, event, t, arrived, day, rec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				computer, tool, session, event, t, now, at, JSON.stringify({ ...rec, computer, event, offset: was ? Number(was.offset ?? offset) : offset }))
			if (done.rowsWritten) {
				sql.exec('INSERT OR IGNORE INTO dirty (day) VALUES (?)', at)
				this.marks.set(at, (this.marks.get(at) ?? 0) + 1)
				kept.push(rec)
				sent[kind]++
				counted = true
				// Set at the first kept, not only after the batch, which may fail partway on a read.
				if (kept.length === 1) {
					saveCounts()
					if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(now + FLUSH)
				}
			}
		}
		saveCounts()
		// And after it: the alarm may have gone off while the batch waited on a read.
		if (kept.length && (await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + FLUSH)
		// Open dashboards hear of it at once; a send never waits on the socket.
		if (kept.length) {
			this.shown = null
			this.broadcast()
		}
		return { stored: kept.length, future, records: kept, ...(limited ? { limited } : {}) }
	}

	/**
	 * named returns the name a computer's records are kept under: its own ID,
	 * or, when another account's computer already holds that ID, a stand-in
	 * made from this account and the ID. So naming someone else's computer
	 * neither takes it over nor hides one's own. An ID no one holds yet is
	 * asked about again at the next batch. A stand-in, once used, is kept in
	 * storage and used from then on, whoever holds the ID later and whenever
	 * the hub restarts: going back to the real ID would file one computer's
	 * records under two names, and count time on both twice.
	 */
	private async named(userID: number, computer: string): Promise<string> {
		if (computer === 'cloud') return computer
		const known = this.names.get(computer)
		if (known) return known
		const sql = this.ctx.storage.sql
		const kept = sql.exec('SELECT v FROM meta WHERE k = ?', `name:${computer}`).toArray()[0]?.v
		if (kept) {
			this.names.set(computer, String(kept))
			return String(kept)
		}
		const row = await this.env.DB.prepare('SELECT user_id FROM computers WHERE id = ?').bind(computer).first<{ user_id: number }>()
		if (!row) return computer
		const name = row.user_id === userID ? computer : await computerAlias(userID, computer)
		if (name !== computer) sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', `name:${computer}`, name)
		this.names.set(computer, name)
		return name
	}

	/** The sealed days being read back from R2, and the read each one's records wait on. */
	private loading = new Map<string, Promise<void>>()

	/**
	 * load reads a sealed day's records back from R2 into the working copy, once.
	 * The day counts as loaded only after its records are in, so a hub reset
	 * during the read reads it again rather than go on without them. Records
	 * that arrive while it is read wait on the same read: one of their own
	 * could return what R2 held before a flush wrote the first one there.
	 * It returns nothing once the day is loaded, and the read to wait on until
	 * then; a caller asks again after the read, as add does, since a flush may
	 * have forgotten the day by the time the caller goes on.
	 */
	private load(userID: number, day: string) {
		if (this.ctx.storage.sql.exec('SELECT 1 FROM loaded WHERE day = ?', day).toArray().length) return
		let reading = this.loading.get(day)
		if (!reading) {
			reading = this.read(userID, day).finally(() => this.loading.delete(day))
			this.loading.set(day, reading)
		}
		return reading
	}
	private async read(userID: number, day: string) {
		const sql = this.ctx.storage.sql
		const body = await this.readDay(userID, day)
		for (const line of (body ?? '').split('\n')) {
			if (!line) continue
			const r = JSON.parse(line) as Rec & { computer: string; event: string }
			sql.exec(`INSERT OR IGNORE INTO recs (computer, tool, session, event, t, arrived, day, rec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, r.computer, r.tool, r.session, r.event, r.t, r.arrived, day, line)
		}
		sql.exec('INSERT OR IGNORE INTO loaded (day) VALUES (?)', day)
	}

	/** readDay reads a day's records from R2, or null. The tests hold it open, in test/hub-entry.ts. */
	protected async readDay(userID: number, day: string): Promise<string | null> {
		const obj = await this.env.REPORTS.get(dayKey(userID, day))
		return obj ? new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text() : null
	}

	async alarm() {
		await this.flush()
	}

	/**
	 * flush writes every changed day to R2 and its totals to D1, then forgets
	 * the working copy of sealed days. It returns the days it wrote.
	 */
	async flush(): Promise<string[]> {
		// One at a time: two at once could write a day's older copy over its newer one.
		const run = this.flushes.then(() => this.writeDays())
		this.flushes = run.catch(() => {})
		return run
	}

	/** The flushes waiting in this hub, run one after another. */
	private flushes: Promise<unknown> = Promise.resolve()
	/** Records kept for each day since this hub started, so a flush can tell one arrived while it wrote the day. */
	private marks = new Map<string, number>()

	private async writeDays(): Promise<string[]> {
		const sql = this.ctx.storage.sql
		const user = Number(sql.exec(`SELECT v FROM meta WHERE k = 'user'`).toArray()[0]?.v)
		const days = sql.exec('SELECT day FROM dirty ORDER BY day').toArray().map((r) => String(r.day))
		if (!user) return []
		for (const day of days) {
			const mark = this.marks.get(day)
			const lines = sql.exec('SELECT rec FROM recs WHERE day = ? ORDER BY t, computer, tool, session, event', day).toArray().map((r) => String(r.rec))
			await this.writeDay(user, day, lines)
			// The day stays marked until it is written, so a write that fails, or
			// a hub reset partway through one, leaves it for the next flush; and
			// it stays marked when a record arrived while it was written.
			if (this.marks.get(day) === mark) {
				sql.exec('DELETE FROM dirty WHERE day = ?', day)
				this.marks.delete(day)
			}
		}
		// The computers the days came from show their new totals on the dashboard and in the review app.
		const touched = new Set<string>()
		for (const day of days) for (const r of sql.exec('SELECT DISTINCT computer FROM recs WHERE day = ?', day).toArray()) touched.add(String(r.computer))
		// One computer's row failing must not keep the rest from theirs, nor sealed days from being forgotten below; the next flush of its days tries again.
		for (const c of touched) {
			try {
				await refreshRecordComputer(this.env, user, c)
			} catch (e) {
				console.error(JSON.stringify({ message: 'could not refresh a computer from its records', user, computer: c, error: String(e) }))
			}
		}
		// Sealed days live in R2 alone from here on.
		const sealed = dayOf(Date.now() - SEAL - DAY, 0)
		sql.exec('DELETE FROM recs WHERE day < ? AND day NOT IN (SELECT day FROM dirty)', sealed)
		sql.exec('DELETE FROM loaded WHERE day NOT IN (SELECT DISTINCT day FROM recs)')
		return days
	}

	/** writeDay writes one day's records to R2, and its totals and commits to D1. The tests hold it open, in test/hub-entry.ts. */
	protected async writeDay(user: number, day: string, lines: string[]) {
		const body = lines.join('\n') + '\n'
		const gzip = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
		await this.env.REPORTS.put(dayKey(user, day), gzip)
		const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')
		const recs = lines.map((l) => JSON.parse(l) as Rec & { computer: string; offset: number })
		// Records are filed in a day by the offset the account had then. Should it have moved, the day's window is the one most were filed under.
		const seen = new Map<number, number>()
		for (const r of recs) seen.set(r.offset ?? 0, (seen.get(r.offset ?? 0) ?? 0) + 1)
		const offset = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
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
					`INSERT INTO prompt_days (user_id, computer_id, day, witnessed_seconds, unwitnessed_seconds, prompts, tokens_in, tokens_out, lines_added, lines_removed, projects, sha256, rules, updated_at, blocks, uncapped_seconds)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
					 ON CONFLICT (user_id, computer_id, day) DO UPDATE SET witnessed_seconds = ?4, unwitnessed_seconds = ?5, prompts = ?6, tokens_in = ?7,
						tokens_out = ?8, lines_added = ?9, lines_removed = ?10, projects = ?11, sha256 = ?12, rules = ?13, updated_at = ?14, blocks = ?15, uncapped_seconds = ?16`,
				// uncapped_seconds: what the day's records added up to when that was more than the 16 hours credited, else NULL.
				).bind(user, computer, day, Math.round(s.witnessed / 1000), Math.round(s.unwitnessed / 1000), s.prompts, s.tokens_in, s.tokens_out, s.lines_added, s.lines_removed, JSON.stringify(projects), computer ? '' : hash, RULES, now, JSON.stringify(day_blocks), s.uncapped ? Math.round(s.uncapped / 1000) : null)
			}),
		)
		// Commits go to their project's row, for links and the GitHub check.
		const commits = new Map<string, Commit[]>()
		for (const r of recs) if (r.sha) commits.set(r.project, [...(commits.get(r.project) ?? []), { sha: r.sha, t: r.t, added: r.added ?? 0, removed: r.removed ?? 0, seen: r.arrived }])
		for (const [project, list] of commits) await remember(this.env, user, project, list)
	}

	/** records returns the working copy's records from one time on, for live views. */
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

	/**
	 * view is what one kind of socket is sent: a profile's visitors never learn
	 * the project. The state is worked out at most once in LIVE_FOR, or when a
	 * record arrives, however many sockets ask.
	 */
	private view(tag: string): Live {
		const now = Date.now()
		if (!this.shown || now - this.shown.at > LIVE_FOR) this.shown = { at: now, live: this.live(now) }
		const l = this.shown.live
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
		// Anyone can open a profile's socket, so one account holds only so many.
		if (tag === 'public' && this.ctx.getWebSockets('public').length >= MAX_PUBLIC_SOCKETS) return new Response(null, { status: 429 })
		const [client, server] = Object.values(new WebSocketPair())
		this.ctx.acceptWebSocket(server!, [tag])
		server!.send(JSON.stringify(this.view(tag)))
		return new Response(null, { status: 101, webSocket: client })
	}

	webSocketMessage(ws: WebSocket) {
		const tag = this.ctx.getTags(ws)[0] ?? 'public'
		// A page asks when it wakes, which is seldom. A visitor's socket that asks over and over is closed.
		if (tag !== 'owner') {
			const now = Date.now()
			const seen = (ws.deserializeAttachment() as { at: number; n: number } | null) ?? { at: now, n: 0 }
			const next = now - seen.at > 60_000 ? { at: now, n: 1 } : { at: seen.at, n: seen.n + 1 }
			if (next.n > PUBLIC_MESSAGES) return ws.close(1008, 'Too many messages.')
			ws.serializeAttachment(next)
		}
		// Anything a page sends asks for the current state, such as after it wakes.
		ws.send(JSON.stringify(this.view(tag)))
	}

	/** closePublic closes every visitor's socket, when the profile stops being one anyone may see. */
	async closePublic() {
		for (const ws of this.ctx.getWebSockets('public')) {
			try {
				ws.close(1000, 'This profile is no longer public.')
			} catch {}
		}
	}

	/**
	 * forgetComputer removes one computer's records on the days given, which
	 * are the days D1 has totals of it for, and on any day the working copy
	 * holds some, from the working copy and from each day's file in R2, and
	 * works those days out again without it. A sealed day is read back first.
	 * It returns how many records it removed. The caller deletes the
	 * computer's own rows of day totals after.
	 */
	async forgetComputer(userID: number, computer: string, days: string[]): Promise<number> {
		const sql = this.ctx.storage.sql
		sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('user', ?)`, String(userID))
		// The pass takes its turn among the flushes. A flush forgets the sealed
		// days that have nothing new, so one that ran while a later day was
		// still being read would drop the days already read back, and the
		// computer's records would stay in their files in R2.
		const pass = this.flushes.then(async () => {
			let removed = 0
			for (const day of days) {
				// Asked again after each read, as in add: the day counts as loaded only once its records are in.
				for (let read; (read = this.load(userID, day)); ) await read
			}
			// Every day of it the working copy now holds: the ones read back, and ones not yet written to D1.
			for (const { day } of sql.exec('SELECT DISTINCT day FROM recs WHERE computer = ?', computer).toArray()) {
				removed += sql.exec('DELETE FROM recs WHERE computer = ? AND day = ?', computer, String(day)).rowsWritten
				sql.exec('INSERT OR IGNORE INTO dirty (day) VALUES (?)', String(day))
				this.marks.set(String(day), (this.marks.get(String(day)) ?? 0) + 1)
			}
			return removed
		})
		this.flushes = pass.catch(() => {})
		const removed = await pass
		// The stand-in an ID is kept under stays (see named): only its clock goes.
		sql.exec('DELETE FROM meta WHERE k = ?', `clock:${computer}`)
		this.names.delete(computer)
		this.shown = null
		await this.flush()
		return removed
	}

	webSocketClose(ws: WebSocket, code: number) {
		try {
			ws.close(code)
		} catch {}
	}

	/** forget empties the hub, when its person deletes their account. */
	async forget() {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1000, 'This account was deleted.')
			} catch {}
		}
		await this.ctx.storage.deleteAlarm()
		await this.ctx.storage.deleteAll()
		this.sent = null
		this.shown = null
		this.names.clear()
		this.schema()
	}
}
