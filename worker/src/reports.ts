// Signed reports from `teardrop sync` and `teardrop export`: checking them,
// storing the latest one of each computer, and reading them back.
import type { User } from './auth.ts'
import { fromBase64Url, Refusal } from './http.ts'

/** The largest report accepted, the same as the Go server. */
export const MAX_REPORT_BYTES = 16 << 20
/** How far ahead of this clock a report may say it was made. */
const CLOCK_SKEW = 5 * 60_000
/** How long a report's key stays valid. */
const KEY_LIFETIME = 7 * 86400_000
/**
 * D1 stores at most 2 MB in one value. A character is at most 3 bytes in
 * UTF-8, so pieces of this many characters always fit.
 */
const CHUNK_CHARS = 600_000

interface Payload {
	kind?: string
	account?: string
	generated_at?: string
	expires_at?: string
	teardrop_version?: string
	report?: { engaged_seconds?: number; blocks?: { end?: string }[] }
}

const refuse = (why: string) => new Refusal(400, `Report refused: ${why}`)

/**
 * storeReport checks a signed report the way `teardrop` itself does and keeps
 * it as the latest report of the computer that signed it. It returns the
 * computer's ID.
 */
export async function storeReport(env: Env, user: User, body: string): Promise<string> {
	let signed: { v?: unknown; payload?: unknown; key?: unknown }
	let p: Payload
	try {
		signed = JSON.parse(body)
		if (signed?.v !== 1 || typeof signed.payload !== 'string' || typeof signed.key !== 'string') throw new Error()
		p = JSON.parse(signed.payload)
	} catch {
		throw refuse('it is not a signed teardrop report. Make one with: teardrop export -o stats.json')
	}
	if (p.kind) throw refuse('it is a project submission. Send those with: teardrop submit')
	const publicKey = fromBase64Url(p.account ?? '')
	const signature = fromBase64Url(signed.key)
	let valid = false
	if (publicKey?.length === 32 && signature?.length === 64) {
		const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify'])
		valid = await crypto.subtle.verify('Ed25519', key, signature, new TextEncoder().encode(signed.payload))
	}
	if (!valid || !publicKey) throw refuse('its key does not match its contents, so it was changed after it was made.')

	const now = Date.now()
	const generated = Date.parse(p.generated_at ?? '')
	const expires = Date.parse(p.expires_at ?? '')
	if (!(generated <= now + CLOCK_SKEW)) throw refuse('it says it was made in the future. Check the clock on your computer.')
	if (!(now < expires)) throw refuse('its key has expired. Run teardrop sync, or export a fresh file.')
	if (expires - generated > KEY_LIFETIME) throw refuse('its key is valid for longer than teardrop allows.')
	if ((p.report?.blocks ?? []).some((b) => !(Date.parse(b.end ?? '') <= generated + CLOCK_SKEW))) {
		throw refuse('it has activity after the time it was made.')
	}

	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))
	const id = 'td-' + [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('')
	const taken = new Refusal(409, 'This computer already syncs to another account. Remove it there, under Settings, then Computers, and sync again.')
	const stale = new Refusal(409, 'The server already has a newer report from this computer.')
	const existing = await env.DB.prepare('SELECT user_id, public_key, generated_at FROM computers WHERE id = ?')
		.bind(id)
		.first<{ user_id: number; public_key: string; generated_at: number }>()
	if (existing && (existing.user_id !== user.id || existing.public_key !== p.account)) throw taken
	if (existing && existing.generated_at >= generated) throw stale

	const chunks: string[] = []
	for (let at = 0; at < signed.payload.length; ) {
		let end = Math.min(signed.payload.length, at + CHUNK_CHARS)
		// Don't cut a character that takes two UTF-16 units in half.
		if (end < signed.payload.length && (signed.payload.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--
		chunks.push(signed.payload.slice(at, end))
		at = end
	}
	// One transaction. The pieces are only replaced if the first statement
	// took effect, which it doesn't when another upload got in first.
	const applied = 'EXISTS (SELECT 1 FROM computers WHERE id = ?1 AND signature = ?2)'
	const results = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO computers (id, user_id, public_key, signature, generated_at, synced_at, teardrop_version, engaged_seconds)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
			 ON CONFLICT (id) DO UPDATE SET signature = excluded.signature, generated_at = excluded.generated_at,
				synced_at = excluded.synced_at, teardrop_version = excluded.teardrop_version, engaged_seconds = excluded.engaged_seconds
			 WHERE computers.user_id = excluded.user_id AND computers.public_key = excluded.public_key
				AND computers.generated_at < excluded.generated_at`,
		).bind(id, user.id, p.account, signed.key, generated, now, String(p.teardrop_version ?? ''), Math.round(Number(p.report?.engaged_seconds) || 0)),
		env.DB.prepare(`DELETE FROM report_chunks WHERE computer_id = ?1 AND ${applied}`).bind(id, signed.key),
		...chunks.map((data, seq) =>
			env.DB.prepare(`INSERT INTO report_chunks (computer_id, seq, data) SELECT ?1, ?3, ?4 WHERE ${applied}`).bind(id, signed.key, seq, data),
		),
	])
	if (!results[0]?.meta.changes) throw stale
	return id
}

/**
 * reportsJSON returns, as JSON text, the latest report of each of a person's
 * computers: [{"id", "synced_at", "report": <the signed payload>}]. The stored
 * payloads are spliced in as they are, without parsing them.
 */
export async function reportsJSON(env: Env, userID: number): Promise<string> {
	const { results } = await env.DB.prepare(
		`SELECT c.id, c.synced_at, r.data FROM computers c JOIN report_chunks r ON r.computer_id = c.id
		 WHERE c.user_id = ? ORDER BY c.id, r.seq`,
	)
		.bind(userID)
		.all<{ id: string; synced_at: number; data: string }>()
	const computers = new Map<string, { synced_at: number; data: string[] }>()
	for (const row of results) {
		const c = computers.get(row.id) ?? { synced_at: row.synced_at, data: [] }
		c.data.push(row.data)
		computers.set(row.id, c)
	}
	const items = [...computers].map(([id, c]) => `{"id":${JSON.stringify(id)},"synced_at":${c.synced_at},"report":${c.data.join('')}}`)
	return `[${items.join(',')}]`
}

export interface Computer {
	id: string
	synced_at: number
	generated_at: number
	teardrop_version: string
	engaged_seconds: number
}

export async function computers(env: Env, userID: number): Promise<Computer[]> {
	const { results } = await env.DB.prepare(
		'SELECT id, synced_at, generated_at, teardrop_version, engaged_seconds FROM computers WHERE user_id = ? ORDER BY synced_at DESC',
	)
		.bind(userID)
		.all<Computer>()
	return results
}

/** removeComputer forgets one of a person's computers and its report. */
export async function removeComputer(env: Env, userID: number, id: string): Promise<boolean> {
	// Deleting the computer deletes its report pieces with it (ON DELETE CASCADE).
	const res = await env.DB.prepare('DELETE FROM computers WHERE id = ? AND user_id = ?').bind(id, userID).run()
	return res.meta.changes > 0
}
