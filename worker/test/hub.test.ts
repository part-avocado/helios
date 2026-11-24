// The hub never loses a record while it writes days to R2: not one that
// arrives during the write, nor any when the write fails or the hub is reset
// partway through it, as a deploy does. It runs the hub of test/hub-entry.ts.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestHarness, experimental_readRawConfig, unstable_splitSqlQuery } from 'wrangler'

const DAY = 86400_000

type Hub = { flush(): Promise<string[]>; holdWrites(): Promise<void>; writing(): Promise<number>; releaseWrites(): Promise<void>; failNextWrite(): Promise<void>; crash(): Promise<void>; holdReads(t: number): Promise<void>; reading(): Promise<number>; releaseRead(all?: boolean): Promise<void>; flushAsReadEnds(): Promise<string[]>; failNextRead(): Promise<void>; alarmAt(): Promise<number | null>; clearAlarm(): Promise<void> }

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
		const { api_key: key } = (await (await site.fetch('/api/me')).json()) as { api_key: string }
		const id = (await env.DB.prepare('SELECT id FROM users WHERE slack_id = ?').bind('UDEV').first<{ id: number }>())!.id
		const hub = () => env.HUB.get(env.HUB.idFromName(String(id)))
		// Records go in one batch, at a UTC offset in minutes.
		const post = (records: { t: number; session: string; event?: string }[], offset = 0) =>
			site.fetch('/api/v1/events', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Teardrop-UTC-Offset': String(offset) }, body: records.map(({ t, session, event }) => JSON.stringify({ t: new Date(t).toISOString(), tool: 'cursor', event: event ?? 'turn_end', session, project: 'p', in: 1 })).join('\n') })
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

		// A record that arrives while its day is being written is written by the
		// next flush, even for a day old enough that a flush forgets it after.
		const d1 = Date.now() - 9 * DAY
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
		const d2 = Date.now() - 4 * DAY
		await send(d2, 'failed once')
		await hub().failNextWrite()
		await assert.rejects(hub().flush())
		await hub().flush()
		assert.deepEqual(await inR2(d2), ['failed once'])

		// A hub reset in the middle of a write, as a deploy resets it, writes the day once it is back.
		const d3 = Date.now() - 5 * DAY
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
		const d4 = Date.now() - 6 * DAY
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
		const d5 = Date.now() - 7 * DAY
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
		const d6 = Date.now() - 8 * DAY
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
		const d7 = Date.now() - 10 * DAY
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
		const midnight = Math.floor(Date.now() / DAY) * DAY
		const d8 = midnight - 14 * DAY + 30 * 60_000
		assert.equal(await send(d8, 'moved'), 1)
		await hub().flush()
		assert.equal(await send(d8, 'moved', -60), 0, 'the record is a repeat')
		await hub().flush()
		assert.deepEqual([await inR2(d8 - DAY), await inR2(d8)], [[], ['moved']])

		// So is a turn's usage, which replaces what it had, in the day it is in.
		const d9 = midnight - DAY + 30 * 60_000
		await send(d9, 'usage', 0, 'usage')
		await send(d9, 'usage', -60, 'usage')
		await hub().flush()
		assert.deepEqual([await inR2(d9 - DAY), await inR2(d9)], [[], ['usage']])

		// A batch that fails partway still has the records it kept flushed.
		await hub().flush()
		await hub().clearAlarm()
		await hub().failNextRead()
		const failed = await post([{ t: Date.now() - 60_000, session: 'kept' }, { t: Date.now() - 20 * DAY, session: 'unread' }])
		assert.equal(failed.status, 500)
		assert.ok((await hub().alarmAt()) != null, 'a flush is due for the record kept')
	} finally {
		await site.close()
		rmSync(config, { force: true })
	}
})
