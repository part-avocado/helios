// Events from Amp threads that run in Amp's cloud. The cloud plugin sends
// them with the person's sync key; one of the person's computers takes them
// into its journal at its next sync and counts them there. The server only
// holds them in between, and never works out time from them itself.
import type { User } from './auth.ts'
import { Refusal } from './http.ts'

/** The largest upload of events accepted. */
export const MAX_EVENTS_BYTES = 512 << 10
/** The longest one event's line may be. */
const MAX_LINE_CHARS = 2000
/** How many events may wait for one person. */
const MAX_WAITING = 50_000
/** How many events one answer hands over. */
const PAGE = 2000
/** How far ahead of this clock an event may say it happened. */
const CLOCK_SKEW = 5 * 60_000
/** Events older than this are not taken. */
const MAX_AGE = 30 * 86400_000
/** Another computer may take over a person's events once theirs has not asked for this long. */
const TAKEOVER = 7 * 86400_000

/**
 * holdEvents keeps the journal lines in body, one per line, until one of the
 * person's computers takes them. Lines that are not an Amp event are left
 * out, and one sent twice is kept once. It returns how many were new.
 */
export async function holdEvents(env: Env, user: User, body: string): Promise<number> {
	const now = Date.now()
	const rows: { session: string; t: string; event: string; line: string }[] = []
	for (const line of body.split('\n')) {
		if (!line.trim() || line.length > MAX_LINE_CHARS) continue
		let ev: { tool?: unknown; session?: unknown; t?: unknown; event?: unknown }
		try {
			ev = JSON.parse(line)
		} catch {
			continue
		}
		if (ev?.tool !== 'amp' || typeof ev.session !== 'string' || typeof ev.t !== 'string' || typeof ev.event !== 'string') continue
		const at = Date.parse(ev.t)
		if (!ev.session || ev.session.length > 200 || !ev.event || ev.event.length > 64 || !(at <= now + CLOCK_SKEW) || !(at >= now - MAX_AGE)) continue
		// The line is kept as sent: parsing it here would round its large numbers.
		rows.push({ session: ev.session, t: ev.t, event: ev.event, line })
	}
	if (!rows.length) return 0
	const waiting = await env.DB.prepare('SELECT COUNT(*) AS n FROM relayed_events WHERE user_id = ?').bind(user.id).first<{ n: number }>()
	if ((waiting?.n ?? 0) + rows.length > MAX_WAITING) {
		throw new Refusal(429, 'Too many events are waiting for this account. Run teardrop sync on your computer to take them.')
	}
	const result = await env.DB.prepare(
		`INSERT OR IGNORE INTO relayed_events (user_id, received_at, session, t, event, line)
		 SELECT ?1, ?2, value ->> 'session', value ->> 't', value ->> 'event', value ->> 'line' FROM json_each(?3)`,
	)
		.bind(user.id, now, JSON.stringify(rows))
		.run()
	return result.meta.changes
}

/**
 * takeEvents hands the person's waiting events to the computer that asks,
 * oldest first, and forgets the ones it says it has: those up to `after`.
 * Only one computer gets a person's events. Another gets none, unless the
 * first has not asked for a week.
 */
export async function takeEvents(env: Env, user: User, params: URLSearchParams): Promise<{ last: number; lines: string[] }> {
	const computer = params.get('computer') ?? ''
	if (!/^td-[0-9a-f]{12}$/.test(computer)) throw new Refusal(400, 'Say which computer is asking.')
	const after = /^\d{1,15}$/.test(params.get('after') ?? '') ? Number(params.get('after')) : 0
	const now = Date.now()
	const mine = await env.DB.prepare(
		`UPDATE users SET relay_computer = ?1, relay_pulled_at = ?2
		 WHERE id = ?3 AND (relay_computer = '' OR relay_computer = ?1 OR relay_pulled_at < ?4)`,
	)
		.bind(computer, now, user.id, now - TAKEOVER)
		.run()
	if (!mine.meta.changes) return { last: after, lines: [] }
	const [, page] = await env.DB.batch<{ id: number; line: string }>([
		env.DB.prepare('DELETE FROM relayed_events WHERE user_id = ? AND id <= ?').bind(user.id, after),
		env.DB.prepare(`SELECT id, line FROM relayed_events WHERE user_id = ? AND id > ? ORDER BY id LIMIT ${PAGE}`).bind(user.id, after),
	])
	const rows = page!.results
	return { last: rows.at(-1)?.id ?? after, lines: rows.map((r) => r.line) }
}
