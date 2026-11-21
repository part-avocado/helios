// Signed reports from `teardrop sync` and `teardrop export`: checking them,
// storing the latest one of each computer, and reading them back.
import { newKey, type User } from './auth.ts'
import { fromBase64Url, Refusal } from './http.ts'
import { dayChanges, dayTotals, type Detail, type Entry, findings, logEntry, type LogEvent, logRemoval, parseDays, parseStored, pastAdded, projectChanges, projectTotals, removedReport, type ReportBody, summarize } from './log.ts'

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
	since?: string
	teardrop_version?: string
	report?: ReportBody
}

/** A refusal that reviewers should see, because the teardrop CLI never causes it. */
class FlaggedRefusal extends Refusal {}

const refuse = (why: string) => new Refusal(400, `Report refused: ${why}`)

/**
 * storeReport checks a signed report the way `teardrop` itself does and keeps
 * it as the latest report of the computer that signed it. It returns the
 * computer's ID. Stored or refused, the report goes in the person's log.
 */
export async function storeReport(env: Env, user: User, body: string, event: LogEvent): Promise<string> {
	// What the log will say about this report, filled in as it is read.
	const entry: Entry = {
		at: Date.now(),
		event,
		computer_id: '',
		refusal: '',
		flagged: 0,
		generated_at: null,
		teardrop_version: '',
		since: '',
		engaged_seconds: 0,
		prev_generated_at: null,
		prev_since: null,
		prev_engaged_seconds: null,
		prev_teardrop_version: null,
		past_added_seconds: null,
		detail: null,
	}
	try {
		return await store(env, user, body, entry)
	} catch (e) {
		if (!(e instanceof Refusal)) throw e
		const refused: Entry = { ...entry, refusal: e.message, flagged: Number(e instanceof FlaggedRefusal), prev_generated_at: null, prev_since: null, prev_engaged_seconds: null, prev_teardrop_version: null, past_added_seconds: null }
		await env.DB.batch(logEntry(env, user.id, refused))
		throw e
	}
}

async function store(env: Env, user: User, body: string, entry: Entry): Promise<string> {
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
	const bytes = new TextEncoder().encode(signed.payload)
	let valid = false
	if (publicKey?.length === 32 && signature?.length === 64) {
		const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify'])
		valid = await crypto.subtle.verify('Ed25519', key, signature, bytes)
	}
	const digest = publicKey?.length === 32 ? new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)) : null
	const id = digest ? 'td-' + [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('') : ''
	const now = entry.at
	const generated = Date.parse(p.generated_at ?? '')
	const engaged = Math.round(Number(p.report?.engaged_seconds) || 0)
	const version = String(p.teardrop_version ?? '').slice(0, 64)
	const since = String(p.since ?? '').slice(0, 32)
	// A refused report's contents are logged too, so a reviewer sees what it claimed.
	const held = summarize(p.report, bytes.length)
	Object.assign(entry, { computer_id: id, generated_at: Number.isFinite(generated) ? generated : null, teardrop_version: version, since, engaged_seconds: engaged, detail: JSON.stringify(held) })
	if (!valid || !publicKey) throw new FlaggedRefusal(400, 'Report refused: its key does not match its contents, so it was changed after it was made.')

	const expires = Date.parse(p.expires_at ?? '')
	if (!(generated <= now + CLOCK_SKEW)) throw refuse('it says it was made in the future. Check the clock on your computer.')
	if (!(now < expires)) throw refuse('its key has expired. Run teardrop sync, or export a fresh file.')
	if (expires - generated > KEY_LIFETIME) throw new FlaggedRefusal(400, 'Report refused: its key is valid for longer than teardrop allows.')
	const blocks = (Array.isArray(p.report?.blocks) ? p.report.blocks : []) as { end?: string }[]
	if (blocks.some((b) => !(Date.parse(b?.end ?? '') <= generated + CLOCK_SKEW))) {
		throw refuse('it has activity after the time it was made.')
	}

	const taken = new FlaggedRefusal(409, 'This computer already syncs to another account. Remove it there, under Settings, then Computers, and sync again.')
	const stale = new Refusal(409, 'The server already has a newer report from this computer.')
	const existing = await env.DB.prepare('SELECT user_id, public_key, generated_at, engaged_seconds, teardrop_version, since, days, projects FROM computers WHERE id = ?')
		.bind(id)
		.first<{ user_id: number; public_key: string; generated_at: number; engaged_seconds: number; teardrop_version: string; since: string; days: string; projects: string }>()
	if (existing && (existing.user_id !== user.id || existing.public_key !== p.account)) throw taken
	if (existing && existing.generated_at >= generated) throw stale

	// Compare the report with the one it replaces. A computer that was removed
	// and comes back is compared with what it had when it left.
	const days = dayTotals(p.report)
	const projects = projectTotals(p.report)
	const before = existing ?? (await removedReport(env, user.id, id))
	if (before) {
		entry.prev_generated_at = before.generated_at
		entry.prev_since = before.since
		entry.prev_engaged_seconds = before.engaged_seconds
		entry.prev_teardrop_version = before.teardrop_version
		if (existing?.days && existing.since === since) entry.past_added_seconds = pastAdded(parseDays(existing.days), days, existing.generated_at)
	}
	entry.flagged = Number(findings(entry).length > 0)

	// What changed since the report this one replaces, day by day and project
	// by project. With nothing to compare it with, everything it holds is listed.
	const comparable = existing && existing.days !== '' && existing.since === since ? existing : null
	const detail: Detail = { ...held, full: !comparable, days: dayChanges(comparable && parseDays(comparable.days), days) }
	// A computer that last synced before project totals were kept has none to compare with.
	if (!comparable || comparable.projects !== '') Object.assign(detail, projectChanges(comparable && parseStored(comparable.projects), projects))
	entry.detail = JSON.stringify(detail)

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
			`INSERT INTO computers (id, user_id, public_key, signature, generated_at, synced_at, teardrop_version, engaged_seconds, since, days, projects)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
			 ON CONFLICT (id) DO UPDATE SET signature = excluded.signature, generated_at = excluded.generated_at,
				synced_at = excluded.synced_at, teardrop_version = excluded.teardrop_version, engaged_seconds = excluded.engaged_seconds,
				since = excluded.since, days = excluded.days, projects = excluded.projects
			 WHERE computers.user_id = excluded.user_id AND computers.public_key = excluded.public_key
				AND computers.generated_at < excluded.generated_at`,
		).bind(id, user.id, p.account, signed.key, generated, now, version, engaged, since, JSON.stringify(days), JSON.stringify(projects)),
		env.DB.prepare(`DELETE FROM report_chunks WHERE computer_id = ?1 AND ${applied}`).bind(id, signed.key),
		...chunks.map((data, seq) =>
			env.DB.prepare(`INSERT INTO report_chunks (computer_id, seq, data) SELECT ?1, ?3, ?4 WHERE ${applied}`).bind(id, signed.key, seq, data),
		),
		...logEntry(env, user.id, entry, 'EXISTS (SELECT 1 FROM computers WHERE id = ? AND signature = ?)', id, signed.key),
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

/**
 * computerReportJSON returns, as JSON text, the latest report of one computer
 * exactly as it was signed, with every work block, or null for a computer
 * the server doesn't know. It is for admins.
 */
export async function computerReportJSON(env: Env, computerID: string): Promise<string | null> {
	const { results } = await env.DB.prepare(
		`SELECT c.user_id, c.synced_at, c.signature, r.data FROM computers c JOIN report_chunks r ON r.computer_id = c.id
		 WHERE c.id = ? ORDER BY r.seq`,
	)
		.bind(computerID)
		.all<{ user_id: number; synced_at: number; signature: string; data: string }>()
	const first = results[0]
	if (!first) return null
	const about = JSON.stringify({ id: computerID, user_id: first.user_id, synced_at: first.synced_at, signature: first.signature })
	return `${about.slice(0, -1)},"report":${results.map((r) => r.data).join('')}}`
}

export interface Computer {
	id: string
	synced_at: number
	generated_at: number
	teardrop_version: string
	engaged_seconds: number
}

/** personDays returns, for each of a person's computers, its latest report's engaged seconds by date. */
export async function personDays(env: Env, userID: number): Promise<Record<string, number>[]> {
	const { results } = await env.DB.prepare('SELECT days FROM computers WHERE user_id = ?').bind(userID).all<{ days: string }>()
	return results.map((c) => parseDays(c.days))
}

export async function computers(env: Env, userID: number): Promise<Computer[]> {
	const { results } = await env.DB.prepare(
		'SELECT id, synced_at, generated_at, teardrop_version, engaged_seconds FROM computers WHERE user_id = ? ORDER BY synced_at DESC',
	)
		.bind(userID)
		.all<Computer>()
	return results
}

/** removeComputer forgets one of a person's computers and its report, and notes that in their log. */
export async function removeComputer(env: Env, userID: number, id: string): Promise<boolean> {
	// Deleting the computer deletes its report pieces with it (ON DELETE CASCADE).
	const results = await env.DB.batch([...logRemoval(env, userID, id), env.DB.prepare('DELETE FROM computers WHERE id = ? AND user_id = ?').bind(id, userID)])
	return results.at(-1)!.meta.changes > 0
}

/**
 * deleteUser empties a person's account: their computers, reports, name, and
 * sync key go. The account's row and its log stay, so deleting an account
 * doesn't hide what it sent from reviewers, and signing in again reopens it.
 */
export async function deleteUser(env: Env, userID: number): Promise<void> {
	await env.DB.batch([
		...logRemoval(env, userID),
		// The log stays, without the names of their projects.
		env.DB.prepare(`UPDATE account_log SET detail = json_remove(detail, '$.projects', '$.more_projects') WHERE user_id = ? AND detail IS NOT NULL`).bind(userID),
		// The report pieces go with the computers (ON DELETE CASCADE).
		env.DB.prepare('DELETE FROM computers WHERE user_id = ?').bind(userID),
		// The new sync key is one no one has seen, so the old one stops working.
		env.DB.prepare(`UPDATE users SET name = '', api_key = ?, deleted_at = ? WHERE id = ?`).bind(newKey(), Date.now(), userID),
	])
}
