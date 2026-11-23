// The upload load test: simulated accounts send records to a teardrop site
// at honest rates, as teardrop's hooks and first sync do, and it prints how
// fast the site answered and what it refused. It exits 1 if the site refused
// any upload, since honest use must never meet the limits in src/hub.ts.
//
//   npx wrangler dev                    # in another terminal, from worker/
//   node scripts/loadtest.ts            # 200 live accounts for a minute, 1 backfill
//   node scripts/loadtest.ts --accounts 50 --seconds 120 --backfills 3
//
// It makes its accounts in the local database itself. It talks only to
// localhost unless given --remote and --keys, a file of sync keys of test
// accounts on a staging site, one per line. Never point it at production:
// it stores a year of made-up records in every account it uses.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: opt } = parseArgs({
	options: {
		server: { type: 'string', default: 'http://127.0.0.1:8787' },
		accounts: { type: 'string', default: '200' }, // live accounts
		seconds: { type: 'string', default: '60' },
		every: { type: 'string', default: '30' }, // seconds between one account's uploads: a prompt and a turn end a minute
		backfills: { type: 'string', default: '1' }, // accounts sending a year of history, as a first sync does
		perDay: { type: 'string', default: '400' }, // records a day of that history: a heavy year
		keys: { type: 'string' },
		remote: { type: 'boolean', default: false },
	},
})
const server = opt.server!.replace(/\/$/, '')
const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(server)
if (!local && !(opt.remote && opt.keys)) {
	console.error(`${server} is not this computer. For a staging site, pass --remote and --keys with test accounts' sync keys.`)
	process.exit(2)
}
const live = Number(opt.accounts), backfills = Number(opt.backfills)

/** keys returns a sync key per account: from --keys, or made in the local database. */
function keys(n: number): string[] {
	if (opt.keys) {
		const all = readFileSync(opt.keys, 'utf8').split('\n').map((k) => k.trim()).filter(Boolean)
		if (all.length < n) throw new Error(`--keys has ${all.length} keys; this run needs ${n}`)
		return all.slice(0, n)
	}
	const made = Array.from({ length: n }, (_, i) => `tdk_loadtest${String(i).padStart(5, '0')}`)
	const rows = made.map((k, i) => `('loadtest-${i}', 'ULOAD${i}', 'Load test ${i}', '${k}', ${Date.now()})`).join(',\n')
	const sql = `INSERT OR IGNORE INTO users (hca_id, slack_id, name, api_key, created_at) VALUES\n${rows};`
	execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--command', sql], { cwd: new URL('..', import.meta.url), stdio: 'ignore' })
	return made
}

interface Result {
	ms: number
	status: number
	stored: number
}

/** upload sends lines as one batch from computer, as teardrop's relay does. */
async function upload(key: string, computer: string, lines: string[]): Promise<Result> {
	const start = performance.now()
	try {
		const res = await fetch(server + '/api/v1/events', {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'X-Teardrop-Computer': computer, 'X-Teardrop-Version': 'dev', 'Content-Type': 'application/x-ndjson' },
			body: lines.join('\n') + '\n',
		})
		const body = await res.text()
		const stored = res.ok ? ((JSON.parse(body) as { records?: number }).records ?? 0) : 0
		return { ms: performance.now() - start, status: res.status, stored }
	} catch {
		return { ms: performance.now() - start, status: 0, stored: 0 }
	}
}

const record = (t: number, session: string, event: string, project: string) =>
	JSON.stringify({ t: new Date(t).toISOString(), tool: 'claude-code', event, session, project, ...(event === 'UserPromptSubmit' ? { human: true, judged: 12, real: 11 } : { in: 40_000, out: 900 }) })
const computerOf = (i: number) => 'td-' + (0x100000000000 + i).toString(16).slice(-12)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** liveAccount sends a prompt or a turn end every `every` seconds, each as it happens. */
async function liveAccount(key: string, i: number, until: number): Promise<Result[]> {
	const out: Result[] = []
	const every = Number(opt.every) * 1000
	await sleep(Math.random() * every) // accounts don't start together
	for (let n = 0; Date.now() < until; n++) {
		out.push(await upload(key, computerOf(i), [record(Date.now(), `live-${i}-${Math.floor(n / 2)}`, n % 2 ? 'Stop' : 'UserPromptSubmit', `github.com/load/p${i % 7}`)]))
		await sleep(Math.min(every * (0.5 + Math.random()), until - Date.now()))
	}
	return out
}

/** backfill sends a year of history in batches of about 200 KB, one after another, as a first sync does. */
async function backfill(key: string, i: number): Promise<Result[]> {
	const day = 86400_000, perDay = Number(opt.perDay)
	const start = Date.now() - 365 * day
	const lines: string[] = []
	for (let d = 0; d < 365; d++) {
		for (let r = 0; r < perDay; r++) lines.push(record(start + d * day + r * 60_000, `old-${i}-${d}-${r >> 1}`, r % 2 ? 'Stop' : 'UserPromptSubmit', `github.com/load/old${i}`))
	}
	const out: Result[] = []
	let batch: string[] = [], size = 0
	for (const line of lines) {
		if (size + line.length + 1 > 200 << 10) {
			out.push(await upload(key, computerOf(100_000 + i), batch))
			batch = []
			size = 0
		}
		batch.push(line)
		size += line.length + 1
	}
	if (batch.length) out.push(await upload(key, computerOf(100_000 + i), batch))
	return out
}

function report(name: string, results: Result[], seconds: number) {
	const ms = results.map((r) => r.ms).sort((a, b) => a - b)
	const at = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]!.toFixed(0) : '-')
	const by = new Map<number, number>()
	for (const r of results) by.set(r.status, (by.get(r.status) ?? 0) + 1)
	const statuses = [...by].sort().map(([s, n]) => `${s || 'no answer'}: ${n}`).join(', ')
	console.log(`${name}: ${results.length} uploads in ${seconds.toFixed(0)}s (${(results.length / seconds).toFixed(1)} a second), ${results.reduce((n, r) => n + r.stored, 0).toLocaleString('en-US')} records stored`)
	console.log(`  latency ms: p50 ${at(0.5)}, p90 ${at(0.9)}, p99 ${at(0.99)}, max ${ms.at(-1)?.toFixed(0) ?? '-'}`)
	console.log(`  answers: ${statuses}`)
	return results.filter((r) => r.status !== 200).length
}

const all = keys(live + backfills)
console.log(`${server}: ${live} live accounts for ${opt.seconds}s, an upload every ~${opt.every}s each; ${backfills} first sync${backfills === 1 ? '' : 's'} of a year at ${opt.perDay} records a day\n`)
const began = Date.now()
const until = began + Number(opt.seconds) * 1000
let liveSeconds = 0
const [liveRuns, backfillRuns] = await Promise.all([
	Promise.all(all.slice(0, live).map((k, i) => liveAccount(k, i, until))).finally(() => (liveSeconds = (Date.now() - began) / 1000)),
	Promise.all(all.slice(live).map((k, i) => backfill(k, i).then((r) => ({ r, seconds: (Date.now() - began) / 1000 })))),
])
let bad = report('Live', liveRuns.flat(), liveSeconds)
for (const [i, b] of backfillRuns.entries()) bad += report(`First sync ${i + 1}`, b.r, b.seconds)
// What src/hub.ts allows, to read the numbers against.
console.log(`\nDefault limits per account (wrangler.jsonc): 1,000 uploads at once, then one a second; 30,000 recent and 1,000,000 older records a day.`)
console.log(`scripts/cost-model.ts assumes 2.15 records a turn and 3 ms of CPU an upload; wrangler dev can't measure CPU.`)
if (bad) {
	console.log(`\n${bad} upload${bad === 1 ? ' was' : 's were'} not taken. Honest use must never be refused.`)
	process.exit(1)
}
