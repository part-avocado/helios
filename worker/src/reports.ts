// Signed reports from `teardrop sync` and `teardrop export`: checking them,
// storing the latest one of each computer, and reading them back. Every report
// is also kept as it arrived, in the REPORTS bucket, for reviewers.
import { noKey, type User } from './auth.ts'
import { cloudComputer } from './events.ts'
import { fromBase64Url, Refusal } from './http.ts'
import { archiveLog, dayChanges, dayTotals, type Detail, type Entry, findings, logEntry, type LogEvent, logRemoval, logRow, parseDays, readArchive, writeArchive, parseStored, pastAdded, projectChanges, projectTotals, removedReport, type ReportBody, summarize } from './log.ts'

/** The largest report accepted, the same as the Go server. */
export const MAX_REPORT_BYTES = 16 << 20
/** How far ahead of this clock a report may say it was made. */
const CLOCK_SKEW = 5 * 60_000
/** How long a report's key stays valid. */
const KEY_LIFETIME = 7 * 86400_000

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
		report_key: null,
	}
	try {
		return await store(env, user, body, entry)
	} catch (e) {
		if (!(e instanceof Refusal)) throw e
		const refused: Entry = { ...entry, refusal: e.message, flagged: Number(e instanceof FlaggedRefusal), prev_generated_at: null, prev_since: null, prev_engaged_seconds: null, prev_teardrop_version: null, past_added_seconds: null }
		await env.DB.batch(logEntry(env, user.id, refused))
		await archiveLog(env, user.id).catch((e) => console.error('could not archive the log', e))
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
	if (p.kind) throw refuse('it is a project submission from an old teardrop, and this site no longer takes submissions')
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
	// Refused or not, it is kept as it arrived. A failure further down leaves
	// a file that no log row names, which costs a little space and nothing else.
	entry.report_key = await keep(env, user.id, id, now, body)
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
	const existing = await env.DB.prepare('SELECT user_id, public_key, generated_at, engaged_seconds, teardrop_version, since, days, projects, report_key FROM computers WHERE id = ?')
		.bind(id)
		.first<{ user_id: number; public_key: string; generated_at: number; engaged_seconds: number; teardrop_version: string; since: string; days: string; projects: string; report_key: string | null }>()
	const existingKey = existing?.report_key ?? null
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
	// What changed since the report this one replaces, day by day and project
	// by project. With nothing to compare it with, everything it holds is listed.
	const comparable = existing && existing.days !== '' && existing.since === since ? existing : null
	const detail: Detail = { ...held, full: !comparable, days: dayChanges(comparable && parseDays(comparable.days), days) }
	if (id === (await cloudComputer(env, user)).id) detail.cloud = true
	// A computer that last synced before project totals were kept has none to compare with.
	if (!comparable || comparable.projects !== '') Object.assign(detail, projectChanges(comparable && parseStored(comparable.projects), projects))
	entry.detail = JSON.stringify(detail)
	entry.flagged = Number(findings(entry).length > 0)

	// The latest report lives in R2 alone, under a name of its own, so an
	// upload that loses the race below leaves the winner's file in place.
	const latestKey = `${user.id}/latest/${id}-${signed.key.slice(0, 16)}.json.gz`
	await env.REPORTS.put(latestKey, await new Response(new Blob([signed.payload]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
	const results = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO computers (id, user_id, public_key, signature, generated_at, synced_at, teardrop_version, engaged_seconds, since, days, projects, blocks, report_key)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
			 ON CONFLICT (id) DO UPDATE SET signature = excluded.signature, generated_at = excluded.generated_at,
				synced_at = excluded.synced_at, teardrop_version = excluded.teardrop_version, engaged_seconds = excluded.engaged_seconds,
				since = excluded.since, days = excluded.days, projects = excluded.projects, blocks = excluded.blocks, report_key = excluded.report_key
			 WHERE computers.user_id = excluded.user_id AND computers.public_key = excluded.public_key
				AND computers.generated_at < excluded.generated_at`,
		).bind(id, user.id, p.account, signed.key, generated, now, version, engaged, since, JSON.stringify(days), JSON.stringify(projects), JSON.stringify(blockTable(p.report)), latestKey),
		// Pieces from before reports moved to R2 are no longer read.
		env.DB.prepare(`DELETE FROM report_chunks WHERE computer_id = ?1 AND EXISTS (SELECT 1 FROM computers WHERE id = ?1 AND signature = ?2)`).bind(id, signed.key),
		...logEntry(env, user.id, entry, 'EXISTS (SELECT 1 FROM computers WHERE id = ? AND signature = ?)', id, signed.key),
	])
	await archiveLog(env, user.id).catch((e) => console.error('could not archive the log', e))
	if (!results[0]?.meta.changes) {
		await env.REPORTS.delete(latestKey)
		throw stale
	}
	// The report this one replaced.
	if (existingKey && existingKey !== latestKey) await env.REPORTS.delete(existingKey).catch(() => {})
	return id
}

/**
 * keep stores a report in the bucket exactly as it arrived, compressed, and
 * returns its name there: the person, the computer, and when it arrived.
 */
async function keep(env: Env, userID: number, computerID: string, at: number, body: string): Promise<string> {
	const key = `${userID}/${computerID || 'unknown'}/${new Date(at).toISOString()}-${crypto.randomUUID().slice(0, 8)}.json.gz`
	const gzip = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))
	await env.REPORTS.put(key, await new Response(gzip).arrayBuffer())
	return key
}

/** forget deletes kept reports. */
async function forget(env: Env, keys: string[]): Promise<void> {
	// The bucket deletes at most 1000 at a time.
	for (let at = 0; at < keys.length; at += 1000) await env.REPORTS.delete(keys.slice(at, at + 1000))
}

/**
 * keptReportJSON returns, as JSON text, the report behind one log row exactly
 * as it was signed, with every work block, or null when none is kept for it.
 * It is for admins.
 */
export async function keptReportJSON(env: Env, entryID: string): Promise<string | null> {
	if (!/^\d{1,15}$/.test(entryID)) return null
	const row = await logRow(env, Number(entryID))
	const kept = row?.report_key ? await env.REPORTS.get(row.report_key) : null
	if (!row || !kept) return null
	// Only a body that parsed as a signed report is ever kept.
	const signed = JSON.parse(await new Response(kept.body.pipeThrough(new DecompressionStream('gzip'))).text()) as { payload: string; key: string }
	const about = JSON.stringify({ entry: Number(entryID), id: row.computer_id, user_id: row.user_id, synced_at: row.at, refusal: row.refusal, signature: signed.key })
	return `${about.slice(0, -1)},"report":${signed.payload}}`
}

/**
 * reportsJSON returns, as JSON text, the latest report of each of a person's
 * computers: [{"id", "synced_at", "report": <the signed payload>}]. The stored
 * payloads are spliced in as they are, without parsing them.
 */
export async function reportsJSON(env: Env, userID: number): Promise<string> {
	const { results } = await env.DB.prepare('SELECT id, synced_at FROM computers WHERE user_id = ? ORDER BY id').bind(userID).all<{ id: string; synced_at: number }>()
	const items: string[] = []
	for (const c of results) {
		const payload = await latestPayload(env, c.id)
		if (payload) items.push(`{"id":${JSON.stringify(c.id)},"synced_at":${c.synced_at},"report":${payload}}`)
	}
	return `[${items.join(',')}]`
}

/**
 * latestPayload returns the signed payload of a computer's latest report, as
 * text: from R2, or from report_chunks for a computer that last synced before
 * reports moved there. null for none.
 */
async function latestPayload(env: Env, computerID: string): Promise<string | null> {
	const row = await env.DB.prepare('SELECT user_id, report_key, since, synced_at FROM computers WHERE id = ?').bind(computerID).first<{ user_id: number; report_key: string | null; since: string; synced_at: number }>()
	if (row?.since === RECORDS) return recordPayload(env, row.user_id, computerID, row.synced_at)
	if (row?.report_key) {
		const obj = await env.REPORTS.get(row.report_key)
		return obj ? new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text() : null
	}
	const { results } = await env.DB.prepare('SELECT data FROM report_chunks WHERE computer_id = ? ORDER BY seq').bind(computerID).all<{ data: string }>()
	return results.length ? results.map((r) => r.data).join('') : null
}

/** The `since` of a computer that sends records, not reports: its view is worked out from them. */
const RECORDS = 'records'

type DayRow = { day: string; s: number; projects: string; blocks: string; updated_at: number }

const recordDays = (env: Env, userID: number, computerID: string) =>
	env.DB.prepare(`SELECT day, witnessed_seconds + unwitnessed_seconds AS s, projects, blocks, updated_at FROM prompt_days WHERE user_id = ? AND computer_id = ? ORDER BY day DESC LIMIT 400`)
		.bind(userID, computerID)
		.all<DayRow>()

const nameOf = (key: string) => key.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 80) || 'unnamed'

/** A day's work blocks, as the hub stores them. */
type DayBlock = [number, number, number, number, number, number, number, number, string, string]

/**
 * recordPayload makes, from a computer's day totals and work blocks, the same
 * shape of payload a synced report has, so the dashboard and review app read
 * a computer that sends records as one that sends reports. It is unsigned:
 * the site worked it out itself.
 */
async function recordPayload(env: Env, userID: number, computerID: string, syncedAt: number): Promise<string> {
	const { results } = await recordDays(env, userID, computerID)
	const projects = new Map<string, number>()
	const blocks: object[] = []
	for (const d of results) {
		for (const [key, [w, u]] of Object.entries(JSON.parse(d.projects) as Record<string, [number, number, number]>)) projects.set(key, (projects.get(key) ?? 0) + w + u)
		for (const [start, end, engaged, prompts, tin, tout, added, removed, key, tools] of JSON.parse(d.blocks) as DayBlock[]) {
			blocks.push({ project: { key, name: nameOf(key) }, start: new Date(start).toISOString(), end: new Date(end).toISOString(), engaged_seconds: engaged, prompts, tokens_in: tin, tokens_out: tout, lines_added: added, lines_removed: removed, lines_kept: 0, tools: tools ? tools.split(',') : [] })
		}
	}
	const report = {
		engaged_seconds: results.reduce((n, d) => n + d.s, 0),
		days: results.filter((d) => d.s > 0).map((d) => ({ date: d.day, engaged_seconds: d.s })).reverse(),
		projects: [...projects].map(([key, s]) => ({ project: { key, name: nameOf(key) }, engaged_seconds: s })),
		blocks: blocks.reverse(),
	}
	return JSON.stringify({ account: '', generated_at: new Date(syncedAt).toISOString(), since: RECORDS, teardrop_version: RECORDS, report })
}

/**
 * refreshRecordComputer updates the computers row of a computer that sends
 * records from its day totals, after the hub writes them, so every list of a
 * person's computers, days, and projects includes it. A computer that synced
 * reports before keeps its key, and its old report is no longer read: its
 * records go back as far as the report did. A computer of another account is left alone.
 */
export async function refreshRecordComputer(env: Env, userID: number, computerID: string): Promise<void> {
	if (!/^td-[0-9a-f]{12}$/.test(computerID)) return
	const [{ results }, old] = await Promise.all([
		recordDays(env, userID, computerID),
		env.DB.prepare('SELECT user_id, report_key FROM computers WHERE id = ?').bind(computerID).first<{ user_id: number; report_key: string | null }>(),
	])
	if (!results.length || (old && old.user_id !== userID)) return
	const days: Record<string, number> = {}
	const projects: Record<string, [string, number]> = {}
	const stored: Record<string, [string, number, number, number, number[][]]> = {}
	for (const d of results) {
		if (d.s > 0) days[d.day] = d.s
		for (const [key, [w, u]] of Object.entries(JSON.parse(d.projects) as Record<string, [number, number, number]>)) {
			if (w + u) projects[key] = [nameOf(key), (projects[key]?.[1] ?? 0) + w + u]
		}
		for (const [start, end, engaged, prompts, tin, tout, added, removed, key] of JSON.parse(d.blocks) as DayBlock[]) {
			const p = (stored[key] ??= [nameOf(key), start, end, 0, []])
			p[1] = Math.min(p[1], start)
			p[2] = Math.max(p[2], end)
			p[3] += engaged
			p[4].push([start, end, engaged, prompts, tin, tout, added, removed, 0])
		}
	}
	for (const p of Object.values(stored)) p[4].sort((a, b) => a[0]! - b[0]!)
	const synced = Math.max(...results.map((d) => d.updated_at))
	const engaged = results.reduce((n, d) => n + d.s, 0)
	await env.DB.prepare(
		`INSERT INTO computers (id, user_id, public_key, signature, generated_at, synced_at, teardrop_version, engaged_seconds, since, days, projects, blocks, report_key)
		 VALUES (?1, ?2, '', '', ?3, ?3, ?4, ?5, ?4, ?6, ?7, ?8, NULL)
		 ON CONFLICT (id) DO UPDATE SET generated_at = excluded.generated_at, synced_at = excluded.synced_at, teardrop_version = excluded.teardrop_version,
			engaged_seconds = excluded.engaged_seconds, since = excluded.since, days = excluded.days, projects = excluded.projects, blocks = excluded.blocks, report_key = NULL
		 WHERE computers.user_id = excluded.user_id`,
	)
		.bind(computerID, userID, synced, RECORDS, engaged, JSON.stringify(days), JSON.stringify(projects), JSON.stringify(stored))
		.run()
	if (old?.report_key) await env.REPORTS.delete(old.report_key).catch(() => {})
}

/**
 * computerReportJSON returns, as JSON text, the latest report of one computer
 * exactly as it was signed, with every work block, or null for a computer
 * the server doesn't know. It is for admins.
 */
export async function computerReportJSON(env: Env, computerID: string): Promise<string | null> {
	const first = await env.DB.prepare('SELECT user_id, synced_at, signature FROM computers WHERE id = ?').bind(computerID).first<{ user_id: number; synced_at: number; signature: string }>()
	const payload = first && (await latestPayload(env, computerID))
	if (!first || !payload) return null
	const about = JSON.stringify({ id: computerID, user_id: first.user_id, synced_at: first.synced_at, signature: first.signature })
	return `${about.slice(0, -1)},"report":${payload}}`
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

/**
 * personProjects adds up each project's engaged seconds over a person's
 * computers, the largest first. Time on one project on two computers at once
 * counts for both, as it does in their total.
 */
export async function personProjects(env: Env, userID: number): Promise<{ key: string; name: string; engaged_seconds: number }[]> {
	const { results } = await env.DB.prepare('SELECT projects FROM computers WHERE user_id = ?').bind(userID).all<{ projects: string }>()
	const all = new Map<string, { key: string; name: string; engaged_seconds: number }>()
	for (const computer of results) {
		for (const [key, [name, seconds]] of Object.entries(parseStored<Record<string, [string, number]>>(computer.projects) ?? {})) {
			const project = all.get(key) ?? { key, name, engaged_seconds: 0 }
			project.engaged_seconds += seconds
			all.set(key, project)
		}
	}
	return [...all.values()].sort((a, b) => b.engaged_seconds - a.engaged_seconds)
}

/** How many work blocks of one project are kept for the graphs, the newest. A year of daily work is a few thousand. */
const BLOCKS_PER_PROJECT = 4000
/** How many work blocks of one computer are kept, the newest, so they fit in one D1 value with room to spare. */
const BLOCKS_PER_COMPUTER = 12000

/**
 * One work block, as numbers for the review app's graphs: start and end in
 * Unix milliseconds, engaged seconds, prompts, tokens read and written, lines
 * added, removed and kept, and which of the person's computers sent it (0 for
 * the one that synced last).
 */
export type BlockRow = [number, number, number, number, number, number, number, number, number, number]

/** A computer's stored blocks: by project key, [name, first start, last end, engaged seconds, blocks without the computer]. */
type StoredBlocks = Record<string, [string, number, number, number, number[][]]>

/**
 * blockTable reads a report's work blocks into what the computers table keeps:
 * numbers grouped by project, the newest blocks only. The first start, last
 * end, and engaged total of each project count every block.
 */
function blockTable(report: ReportBody | undefined): StoredBlocks {
	const n = (v: unknown) => {
		const x = Number(v)
		return Number.isFinite(x) && x > 0 ? Math.round(x) : 0
	}
	const out: StoredBlocks = {}
	const rows: [string, number[]][] = []
	for (const b of Array.isArray(report?.blocks) ? (report.blocks as Record<string, unknown>[]) : []) {
		const p = (b?.project ?? {}) as { key?: unknown; name?: unknown }
		const key = String(p.key ?? p.name ?? '').slice(0, 200)
		const start = Date.parse(String(b?.start ?? ''))
		const end = Date.parse(String(b?.end ?? ''))
		if (!key || !Number.isFinite(start) || !(end >= start)) continue
		// Without a name, the key's last part, since the key can be a folder on their computer.
		const name = String(p.name ?? '').slice(0, 80) || key.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 80) || 'unnamed'
		const project = (out[key] ??= [name, start, end, 0, []])
		const engaged = n(b.engaged_seconds)
		project[1] = Math.min(project[1], start)
		project[2] = Math.max(project[2], end)
		project[3] += engaged
		rows.push([key, [start, end, engaged, n(b.prompts), n(b.tokens_in), n(b.tokens_out), n(b.lines_added), n(b.lines_removed), n(b.lines_kept)]])
	}
	rows.sort((a, b) => a[1][0]! - b[1][0]!)
	for (const [key, row] of rows.slice(-BLOCKS_PER_COMPUTER)) out[key]![4].push(row)
	for (const project of Object.values(out)) project[4] = project[4].slice(-BLOCKS_PER_PROJECT)
	return out
}

/**
 * projectBlocks gathers the work blocks of each of a person's computers by
 * project, the project with the most engaged time first. They are read from
 * what was kept when each report arrived. A computer that last synced before
 * that was kept has its report read once, and what it held is kept then.
 */
export async function projectBlocks(env: Env, userID: number): Promise<{ key: string; name: string; engaged_seconds: number; first_active: number; last_active: number; blocks: BlockRow[] }[]> {
	const { results } = await env.DB.prepare('SELECT id, blocks FROM computers WHERE user_id = ? ORDER BY synced_at DESC, id').bind(userID).all<{ id: string; blocks: string }>()
	const all = new Map<string, { key: string; name: string; engaged_seconds: number; first_active: number; last_active: number; blocks: BlockRow[] }>()
	for (const [computer, row] of results.entries()) {
		// One report at a time, so only one is ever held.
		const stored = row.blocks ? parseStored<StoredBlocks>(row.blocks) : await fillBlocks(env, row.id)
		for (const [key, [name, first, last, engaged, blocks]] of Object.entries(stored ?? {})) {
			const project = all.get(key) ?? { key, name, engaged_seconds: 0, first_active: first, last_active: last, blocks: [] }
			project.engaged_seconds += engaged
			project.first_active = Math.min(project.first_active, first)
			project.last_active = Math.max(project.last_active, last)
			for (const b of blocks) project.blocks.push([...b, computer] as BlockRow)
			all.set(key, project)
		}
	}
	for (const project of all.values()) project.blocks = project.blocks.sort((a, b) => a[0] - b[0]).slice(-BLOCKS_PER_PROJECT)
	return [...all.values()].sort((a, b) => b.engaged_seconds - a.engaged_seconds)
}

/** fillBlocks reads the blocks out of one computer's stored report and keeps them. */
async function fillBlocks(env: Env, computerID: string): Promise<StoredBlocks> {
	const table = blockTable(parseStored<{ report?: ReportBody }>((await latestPayload(env, computerID)) ?? '')?.report)
	// Only if no newer report filled it in meanwhile.
	await env.DB.prepare(`UPDATE computers SET blocks = ? WHERE id = ? AND blocks = ''`).bind(JSON.stringify(table), computerID).run()
	return table
}

export async function computers(env: Env, userID: number): Promise<Computer[]> {
	const { results } = await env.DB.prepare(
		'SELECT id, synced_at, generated_at, teardrop_version, engaged_seconds FROM computers WHERE user_id = ? ORDER BY synced_at DESC',
	)
		.bind(userID)
		.all<Computer>()
	return results
}

/**
 * removeComputer forgets one of a person's computers and its latest report,
 * and notes that in their log. The reports kept for reviewers stay.
 */
export async function removeComputer(env: Env, userID: number, id: string): Promise<boolean> {
	const latest = await env.DB.prepare('SELECT report_key FROM computers WHERE id = ? AND user_id = ?').bind(id, userID).first<{ report_key: string | null }>()
	if (latest?.report_key) await env.REPORTS.delete(latest.report_key)
	// Deleting the computer deletes its report pieces with it (ON DELETE CASCADE).
	const results = await env.DB.batch([
		...logRemoval(env, userID, id),
		env.DB.prepare('DELETE FROM computers WHERE id = ? AND user_id = ?').bind(id, userID),
	])
	await archiveLog(env, userID).catch((e) => console.error('could not archive the log', e))
	return results.at(-1)!.meta.changes > 0
}

/**
 * deleteUser empties a person's account: their computers, reports, name, and
 * sync key go, and so do the reports kept in full. The account's row and its
 * log stay, so deleting an account doesn't hide what it sent from reviewers,
 * and signing in again reopens it.
 */
export async function deleteUser(env: Env, userID: number): Promise<void> {
	await env.DB.batch([
		...logRemoval(env, userID),
		// The log stays, without the names of their projects or the reports themselves.
		env.DB.prepare(`UPDATE account_log SET report_key = NULL, detail = json_remove(detail, '$.projects', '$.more_projects') WHERE user_id = ?`).bind(userID),
		// The report pieces go with the computers (ON DELETE CASCADE).
		env.DB.prepare('DELETE FROM computers WHERE user_id = ?').bind(userID),
		// Their read keys stop working.
		env.DB.prepare('DELETE FROM user_keys WHERE user_id = ?').bind(userID),
		// The events kept from their cloud threads go too.
		env.DB.prepare('DELETE FROM relayed_events WHERE user_id = ?').bind(userID),
		// The new sync key is one no one has seen, so the old one stops working.
		// Their profile goes: its handle is free for someone else, and their choices of what it shows are forgotten.
		env.DB.prepare('DELETE FROM project_settings WHERE user_id = ?').bind(userID),
		env.DB.prepare(`UPDATE users SET name = '', handle = NULL, profile_public = 1, api_key = ?, deleted_at = ? WHERE id = ?`).bind(noKey(), Date.now(), userID),
		env.DB.prepare('DELETE FROM sync_keys WHERE user_id = ?').bind(userID),
	])
	// The archived part of their log stays too, without project names or report keys.
	const { results: archives } = await env.DB.prepare('SELECT key FROM log_archives WHERE user_id = ?').bind(userID).all<{ key: string }>()
	for (const a of archives) {
		const rows = (await readArchive(env, a.key)).map((r) => {
			const detail = parseStored<Record<string, unknown>>(r.detail)
			if (detail) delete detail.projects, delete detail.more_projects
			return { ...r, report_key: null, detail: detail ? JSON.stringify(detail) : r.detail }
		})
		await writeArchive(env, a.key, rows)
	}
	// Their working copy of recent records, and their day totals.
	await env.HUB.get(env.HUB.idFromName(String(userID))).forget()
	await env.DB.prepare('DELETE FROM prompt_days WHERE user_id = ?').bind(userID).run()
	// Everything kept for this person, including their records and what no log row names any more.
	let cursor: string | undefined
	do {
		const page = await env.REPORTS.list({ prefix: `${userID}/`, cursor })
		await forget(env, page.objects.map((o) => o.key))
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)
}
