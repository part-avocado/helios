// The hub never loses a record while it writes days to R2: not one that
// arrives during the write, nor any when the write fails or the hub is reset
// partway through it, as a deploy does. It runs the hub of test/hub-entry.ts.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { createTestHarness, experimental_readRawConfig, unstable_splitSqlQuery } from 'wrangler'

const DAY = 86400_000

type Hub = { flush(): Promise<string[]>; holdWrites(): Promise<void>; writing(): Promise<boolean>; releaseWrites(): Promise<void>; failNextWrite(): Promise<void>; crash(): Promise<void> }

test('the hub loses no record while it writes a day', async () => {
	// The deployed config, run with the test entry.
	const config = new URL('../.hubtest.wrangler.json', import.meta.url)
	const { rawConfig } = experimental_readRawConfig({ config: new URL('../wrangler.jsonc', import.meta.url).pathname })
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
		const send = async (t: number, session: string) => {
			const res = await site.fetch('/api/v1/events', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ t: new Date(t).toISOString(), tool: 'cursor', event: 'turn_end', session, project: 'p' }) })
			assert.equal(res.status, 200)
		}
		const inR2 = async (t: number) => {
			const day = new Date(t).toISOString().slice(0, 10)
			const obj = await env.REPORTS.get(`${id}/prompts/${day.slice(0, 4)}/${day.slice(5)}.ndjson.gz`)
			if (!obj) return []
			return (await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text()).trim().split('\n').map((l) => JSON.parse(l).session).sort()
		}
		const atHold = async () => {
			for (let i = 0; i < 200 && !(await hub().writing()); i++) await new Promise((r) => setTimeout(r, 10))
			assert.ok(await hub().writing(), 'the write reached the hold')
		}

		// A record that arrives while its day is being written is written by the next flush.
		const d1 = Date.now() - 3 * DAY
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
	} finally {
		await site.close()
		rmSync(config, { force: true })
	}
})
