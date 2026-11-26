// The hub never loses a record while it writes days to R2: not one that
// arrives during the write, nor any when the write fails or the hub is reset
// partway through it, as a deploy does. It runs the hub of test/hub-entry.ts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestHarness, experimental_readRawConfig, unstable_splitSqlQuery } from 'wrangler'

const DAY = 86400_000

type Hub = { flush(): Promise<string[]>; holdWrites(): Promise<void>; writing(): Promise<number>; releaseWrites(): Promise<void>; failNextWrite(): Promise<void>; crash(): Promise<void>; holdReads(t: number): Promise<void>; reading(): Promise<number>; releaseRead(all?: boolean): Promise<void>; flushAsReadEnds(): Promise<string[]>; failNextRead(): Promise<void>; alarmAt(): Promise<number | null>; clearAlarm(): Promise<void>; fireAlarm(): Promise<void>; forgetComputer(user: number, computer: string, days: string[]): Promise<number> }

test('the hub loses no record while it writes a day', async () => {
	// The deployed config, run with the test entry.
	const config = new URL('../.hubtest.wrangler.json', import.meta.url)
	const { rawConfig } = experimental_readRawConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) })
	writeFileSync(config, JSON.stringify({ ...rawConfig, main: 'test/hub-entry.ts' }))
	const site = createTestHarness({ workers: [{ configPath: config, vars: { DEV_LOGIN: 'UDEV' }, secrets: { SESSION_SECRET: 'x', HCA_CLIENT_ID: 'a', HCA_CLIENT_SECRET: 'b', ADMINS: '' } }] })
	try {
		await site.listen()
		const env = await site.getWorker().getEnv() as { DB: { prepare(sql: string): { run(): Promise<unknown>; bind(...v: unknown[]): { first<T>(): Promise<T | null> } } }; HUB: { idFromName(n: string): unknown; get(id: unknown): Hub }; REPORTS: { get(k: string): Promise<{ body: ReadableStream } | null> } }
		const migrations = new URL('../migrations/', import.meta.url)
		for (const file of readdirSync(migrations).sort()) {
			for (const statement of unstable_splitSqlQuery(readFileSync(new URL(file, migrations), 'utf8'))) await env.DB.prepare(statement).run()
		}
		await site.fetch('/api/me') // signs the dev person in, which makes the account
		const id = (await env.DB.prepare('SELECT id FROM users WHERE slack_id = ?').bind('UDEV').first<{ id: number }>())!.id
		// A sync key of theirs, put straight in the database as Settings would make it.
		const key = 'tdk_' + 'h'.repeat(32)
		await env.DB.prepare('INSERT INTO sync_keys (user_id, name, hash, hint, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, 'test', createHash('sha256').update(key).digest('hex'), key.slice(0, 9), Date.now()).first()
		const hub = () => env.HUB.get(env.HUB.idFromName(String(id)))
		// Records go in one batch, at a UTC offset in minutes.
		const post = (records: { t: number; session: string; event?: string; in?: number }[], offset = 0) =>
			site.fetch('/api/v1/events', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Helios-UTC-Offset': String(offset) }, body: records.map(({ t, session, event, in: tokens }) => JSON.stringify({ t: new Date(t).toISOString(), tool: 'cursor', event: event ?? 'turn_end', session, project: 'p', in: tokens ?? 1 })).join('\n') })
		const send = async (t: number, session: string, offset = 0, event?: string) => {
			const res = await post([{ t, session, event }], offset)
			assert.equal(res.status, 200)
			return ((await res.json()) as { records: number }).records
		}
		const inR2 = async (t: number) => {
			const day = new Date(t).toISOString().slice(0, 10)
			const obj = await env.REPORTS.get(`${id}/prompts/${day.slice(0, 4)}/${day.slice(5)}.ndjson.gz`)
			if (!obj) return []
			return (await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l).session).sort()
		}
		const atHold = async () => {
			for (let i = 0; i < 200 && !(await hub().writing()); i++) await new Promise((r) => setTimeout(r, 10))
			assert.ok(await hub().writing(), 'the write reached the hold')
		}

		// Records go at noon UTC, so one sent a second or two later is on the same day.
		const midnight = Math.floor(Date.now() / DAY) * DAY
		const noon = midnight + DAY / 2
		const dayOn = (t: number) => new Date(t).toISOString().slice(0, 10)

		// A record that arrives while its day is being written is written by the
		// next flush, even for a day old enough that a flush forgets it after.
		const d1 = noon - 9 * DAY
		await send(d1, 'before')
		await hub().holdWrites()
		const flushing = hub().flush()
		await atHold()
		await send(d1 + 1000, 'during')
		await hub().releaseWrites()
		await flushing
		await hub().flush()
		assert.deepEqual(await inR2(d1), ['before', 'during'])

		// A write that fails leaves its day to the next flush.
		const d2 = noon - 4 * DAY
		await send(d2, 'failed once')
		await hub().failNextWrite()
		await assert.rejects(hub().flush())
		await hub().flush()
		assert.deepEqual(await inR2(d2), ['failed once'])

		// A hub reset in the middle of a write, as a deploy resets it, writes the day once it is back.
		const d3 = noon - 5 * DAY
		await send(d3, 'interrupted')
		await hub().holdWrites()
		const cut = hub().flush().catch(() => {})
		await atHold()
		await hub().crash().catch(() => {})
		await cut
		await hub().flush()
		assert.deepEqual(await inR2(d3), ['interrupted'])

		// A sealed day is read back from R2 before a late record joins it. A
		// reset during that read reads it again, rather than write the late
		// record over what R2 had.
		const d4 = noon - 6 * DAY
		await send(d4, 'sealed')
		await hub().flush()
		await hub().holdReads(d4)
		const late = send(d4 + 1000, 'late, cut off').catch(() => {})
		for (let i = 0; i < 200 && !(await hub().reading()); i++) await new Promise((r) => setTimeout(r, 10))
		assert.equal(await hub().reading(), 1, 'the read reached the hold')
		await hub().crash().catch(() => {})
		await late
		await send(d4 + 2000, 'late')
		await hub().flush()
		assert.deepEqual(await inR2(d4), ['late', 'sealed'])

		// Two late records for one sealed day share its read, so a flush between
		// them can't leave the second with what R2 held before the first.
		const d5 = noon - 7 * DAY
		await send(d5, 'sealed')
		await hub().flush()
		await hub().holdReads(d5)
		const a = send(d5 + 1000, 'a')
		for (let i = 0; i < 200 && !(await hub().reading()); i++) await new Promise((r) => setTimeout(r, 10))
		const b = send(d5 + 2000, 'b')
		// The second waits on the first's read: it neither goes on without one nor starts its own.
		const waited = await Promise.race([b.then(() => false), new Promise((r) => setTimeout(r, 500, true))])
		const reads = await hub().reading()
		await hub().releaseRead()
		await a
		await hub().flush()
		await hub().releaseRead(true)
		await b
		assert.ok(waited, 'the second record waited for the read')
		assert.equal(reads, 1, 'the two records shared one read')
		await hub().flush()
		assert.deepEqual(await inR2(d5), ['a', 'b', 'sealed'])

		// A flush can forget a sealed day between its read ending and the record
		// that waited on the read going on. The record reads the day again,
		// rather than write itself over what R2 has.
		const d6 = noon - 8 * DAY
		await send(d6, 'sealed')
		await hub().flush()
		await hub().holdReads(d6)
		const c = send(d6 + 1000, 'c')
		for (let i = 0; i < 200 && !(await hub().reading()); i++) await new Promise((r) => setTimeout(r, 10))
		const wrote = await hub().flushAsReadEnds()
		await c
		assert.deepEqual(wrote, [], 'the flush ran before the waiting record went on')
		await hub().flush()
		assert.deepEqual(await inR2(d6), ['c', 'sealed'])

		// Flushes run one at a time: a second waits for the first's write, rather
		// than race it with the day's newer copy.
		const d7 = noon - 10 * DAY
		await send(d7, 'first')
		await hub().holdWrites()
		const one = hub().flush()
		await atHold()
		await send(d7 + 1000, 'second')
		const two = hub().flush()
		await new Promise((r) => setTimeout(r, 300))
		const writes = await hub().writing()
		await hub().releaseWrites()
		await Promise.all([one, two])
		assert.equal(writes, 1, 'the second flush waited for the first')
		assert.deepEqual(await inR2(d7), ['first', 'second'])

		// A record sent again under another UTC offset, after its day was sealed
		// and forgotten, is the record R2 already has, not one for the day before.
		const d8 = midnight - 14 * DAY + 30 * 60_000
		assert.equal(await send(d8, 'moved'), 1)
		await hub().flush()
		assert.equal(await send(d8, 'moved', -60), 0, 'the record is a repeat')
		await hub().flush()
		assert.deepEqual([await inR2(d8 - DAY), await inR2(d8)], [[], ['moved']])
		// And the other way, to the day after.
		const d8b = midnight - 16 * DAY - 30 * 60_000
		assert.equal(await send(d8b, 'moved on'), 1)
		await hub().flush()
		assert.equal(await send(d8b, 'moved on', 60), 0, 'the record is a repeat the other way too')
		await hub().flush()
		assert.deepEqual([await inR2(d8b), await inR2(d8b + DAY)], [['moved on'], []])

		// So is a turn's usage, which replaces what it had, in the day it is in,
		// and still counts in that day's totals.
		const d9 = midnight - DAY + 30 * 60_000
		assert.equal((await (await post([{ t: d9, session: 'usage', event: 'usage', in: 1 }])).json() as { records: number }).records, 1)
		await hub().flush()
		assert.equal((await (await post([{ t: d9, session: 'usage', event: 'usage', in: 5 }], -60)).json() as { records: number }).records, 1)
		assert.deepEqual(await hub().flush(), [dayOn(d9)], 'the day the usage is in is the one written')
		assert.deepEqual([await inR2(d9 - DAY), await inR2(d9)], [[], ['usage']])
		const tokens = await env.DB.prepare(`SELECT tokens_in AS n FROM prompt_days WHERE user_id = ? AND computer_id = '' AND day = ?`).bind(id, dayOn(d9)).first<{ n: number }>()
		assert.equal(tokens?.n, 5, "the usage counts in its day's totals")

		// A batch that fails partway still has the records it kept flushed.
		await hub().flush()
		await hub().clearAlarm()
		await hub().failNextRead()
		const failed = await post([{ t: Date.now() - 60_000, session: 'kept' }, { t: Date.now() - 20 * DAY, session: 'unread' }])
		assert.equal(failed.status, 500)
		assert.ok((await hub().alarmAt()) != null, 'a flush is due for the record kept')

		// A record kept after the alarm went off, while the batch waited on a
		// read, has a flush due as well.
		await send(Date.now() - 120_000, 'alarm set')
		const old = noon - 25 * DAY
		await hub().holdReads(old)
		const batch = post([{ t: Date.now() - 90_000, session: 'before the alarm' }, { t: old, session: 'after the alarm' }])
		for (let i = 0; i < 200 && !(await hub().reading()); i++) await new Promise((r) => setTimeout(r, 10))
		assert.equal(await hub().reading(), 1, 'the read reached the hold')
		await hub().fireAlarm()
		await hub().releaseRead(true)
		assert.equal((await (await batch).json() as { records: number }).records, 2)
		assert.ok((await hub().alarmAt()) != null, 'a flush is due for the record kept after the alarm')

		// A computer ID another account holds is kept under a stand-in, and stays
		// under it after that account lets the ID go and the hub restarts: its
		// records are never split between two names.
		const all = async <T>(sql: string, ...v: unknown[]) => (await (env.DB.prepare(sql).bind(...v) as unknown as { all(): Promise<{ results: T[] }> }).all()).results
		const pc = 'td-0000000000b7'
		await env.DB.prepare(`INSERT INTO users (hca_id, api_key, created_at) VALUES ('someone else', 'no key', 0)`).run()
		await env.DB.prepare(`INSERT INTO computers (id, user_id, public_key, signature, generated_at, synced_at) SELECT ?, id, 'k', 's', 0, 0 FROM users WHERE hca_id = 'someone else'`).bind(pc).first()
		const asPC = async (t: number, session: string) => {
			const res = await site.fetch('/api/v1/events', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Helios-UTC-Offset': '0', 'X-Helios-Computer': pc }, body: JSON.stringify({ t: new Date(t).toISOString(), tool: 'cursor', event: 'turn_end', session, project: 'p' }) })
			assert.equal(res.status, 200)
		}
		const names = async () => (await all<{ computer_id: string }>(`SELECT DISTINCT computer_id FROM prompt_days WHERE user_id = ? AND computer_id LIKE 'td-%' ORDER BY computer_id`, id)).map((r) => r.computer_id)
		await asPC(Date.now() - 60_000, 'stand-in 1')
		await hub().flush()
		const standIn = await names()
		assert.equal(standIn.length, 1)
		assert.notEqual(standIn[0], pc)
		await env.DB.prepare('DELETE FROM computers WHERE id = ?').bind(pc).first()
		await hub().crash().catch(() => {})
		await asPC(Date.now() - 50_000, 'stand-in 2')
		await hub().flush()
		assert.deepEqual(await names(), standIn, 'the stand-in is still the name once the ID is free and the hub has restarted')

		// Removing a computer reads its sealed days back one after another. A
		// flush that comes meanwhile waits its turn, rather than forget the days
		// already read back and leave the computer's records in R2.
		const [f1, f2] = [noon - 31 * DAY, noon - 30 * DAY]
		await send(f1, 'forgotten 1')
		await send(f2, 'forgotten 2')
		await hub().flush()
		assert.deepEqual([await inR2(f1), await inR2(f2)], [['forgotten 1'], ['forgotten 2']])
		await hub().holdReads(f2)
		const forgetting = hub().forgetComputer(id, 'cloud', [dayOn(f1), dayOn(f2)])
		for (let i = 0; i < 200 && !(await hub().reading()); i++) await new Promise((r) => setTimeout(r, 10))
		assert.equal(await hub().reading(), 1, 'the second day\'s read reached the hold')
		const meanwhile = hub().flush()
		await new Promise((r) => setTimeout(r, 300))
		await hub().releaseRead(true)
		await Promise.all([forgetting, meanwhile])
		assert.deepEqual([await inR2(f1), await inR2(f2)], [[], []], 'both days were written again without the computer')
	} finally {
		await site.close()
		rmSync(config, { force: true })
	}
})
