// Events from Amp threads that run in Amp's cloud. The cloud plugin sends
// them with the person's sync key, and the site keeps them for a year. No
// computer of the person's is needed: when a cloud thread finishes a turn,
// the teardrop that the plugin runs there reads all of the person's cloud
// events back, counts them, and syncs the result as their cloud computer.
// The server keeps the events and never works out time from them itself.
import { derived, type User } from './auth.ts'
import { fromBase64Url, Refusal, toBase64Url } from './http.ts'

/** The largest upload of events accepted. */
export const MAX_EVENTS_BYTES = 512 << 10
/** The longest one event's line may be. */
const MAX_LINE_CHARS = 2000
/** How many events one person may send in a day. */
const MAX_A_DAY = 10_000
/** How many events one answer hands over. */
const PAGE = 2000
/** How far ahead of this clock an event may say it happened. */
const CLOCK_SKEW = 5 * 60_000
/** Events older than this are not taken. */
const MAX_AGE = 30 * 86400_000
/** How long events are kept: a day longer than the year a report covers. */
const KEPT_FOR = 366 * 86400_000

/**
 * holdEvents keeps the journal lines in body, one per line. Lines that are
 * not an Amp event are left out, and one sent twice is kept once. It returns
 * how many were new.
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
	const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM relayed_events WHERE user_id = ? AND received_at > ?')
		.bind(user.id, now - 86400_000)
		.first<{ n: number }>()
	if ((today?.n ?? 0) + rows.length > MAX_A_DAY) {
		throw new Refusal(429, 'This account has sent more cloud events today than the site keeps. They are sent again later.')
	}
	const [, added] = await env.DB.batch([
		// Events from before the year a report covers are no longer counted.
		env.DB.prepare('DELETE FROM relayed_events WHERE user_id = ? AND received_at < ?').bind(user.id, now - KEPT_FOR),
		env.DB.prepare(
			`INSERT OR IGNORE INTO relayed_events (user_id, received_at, session, t, event, line)
			 SELECT ?1, ?2, value ->> 'session', value ->> 't', value ->> 'event', value ->> 'line' FROM json_each(?3)`,
		).bind(user.id, now, JSON.stringify(rows)),
	])
	return added!.meta.changes
}

/** The DER of an Ed25519 private key, up to its 32 bytes. */
const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]

/**
 * cloudComputer returns the signing key of the computer that a person's
 * cloud threads sync as, and that computer's ID. Every cloud thread of
 * theirs gets the same key, so they all sync as one computer, and it stays
 * the same when they make a new sync key.
 */
export async function cloudComputer(env: Env, user: User): Promise<{ key: string; id: string }> {
	const seed = await derived(env, `cloud computer ${user.id}`)
	const pair = await crypto.subtle.importKey('pkcs8', new Uint8Array([...PKCS8_ED25519, ...seed]), { name: 'Ed25519' }, true, ['sign'])
	const publicKey = fromBase64Url(((await crypto.subtle.exportKey('jwk', pair)) as JsonWebKey).x!)!
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))
	return { key: toBase64Url(seed), id: 'td-' + [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('') }
}

/**
 * readEvents answers a cloud thread that is about to count: the person's
 * kept events after the one numbered `after`, oldest first, and the key to
 * sign the result with. Reading does not remove them, because the next
 * thread starts on a new machine and needs them all again.
 */
export async function readEvents(env: Env, user: User, params: URLSearchParams): Promise<{ key: string; last: number; lines: string[] }> {
	const after = /^\d{1,15}$/.test(params.get('after') ?? '') ? Number(params.get('after')) : 0
	const { results } = await env.DB.prepare(`SELECT id, line FROM relayed_events WHERE user_id = ? AND id > ? ORDER BY id LIMIT ${PAGE}`)
		.bind(user.id, after)
		.all<{ id: number; line: string }>()
	return { key: (await cloudComputer(env, user)).key, last: results.at(-1)?.id ?? after, lines: results.map((r) => r.line) }
}
