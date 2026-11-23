// Runs the Worker in the real Workers runtime with a local D1 database, and
// stands in for Hack Club Auth and the review server with a local HTTP server.
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler'

// The Worker sees requests to this address as coming from the internet. A
// path alone reaches it as localhost.
const SITE = 'http://teardrop.example'
const DAY = 86400_000

// A sign-in code "code-ada" belongs to the person "ada", whose Slack ID is "UADA".
const fake = createServer(async (req, res) => {
	let body = ''
	for await (const chunk of req) body += chunk
	const reply = (value: unknown) => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(value))
	if (req.url === '/oauth/token') {
		const form = new URLSearchParams(body)
		const ok = form.get('client_secret') === 'hca-secret' && form.get('redirect_uri') === `${SITE}/auth/callback`
		return reply(ok ? { access_token: form.get('code')!.replace('code-', 'token-') } : { error: 'invalid_grant' })
	}
	if (req.url === '/oauth/userinfo') {
		const sub = req.headers.authorization!.replace('Bearer token-', '')
		return reply({ sub, slack_id: 'U' + sub.toUpperCase(), name: `<b>${sub}</b>` })
	}
	// A stand-in for GitHub's API: kid/site is public with one commit of the two claimed, kid/secret is private.
	if (req.url === '/repos/kid/site') return reply({ private: false })
	if (req.url === '/repos/kid/site/commits/' + 'a'.repeat(40)) return reply({ sha: 'a'.repeat(40) })
	if (req.url?.startsWith('/repos/kid/site/commits/')) return res.writeHead(422).end()
	res.writeHead(404).end()
})

let server: ReturnType<typeof createTestHarness>

before(async () => {
	await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done))
	const fakeURL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
	server = createTestHarness({
		workers: [
			{
				configPath: new URL('../wrangler.jsonc', import.meta.url),
				vars: { HCA_URL: fakeURL, DEV_LOGIN: 'UDEV' },
				secrets: { SESSION_SECRET: 'test-session-secret', HCA_CLIENT_ID: 'hca-id', HCA_CLIENT_SECRET: 'hca-secret', ADMINS: 'UADMIN, UOTHER' },
			},
		],
	})
	await server.listen()
	const env = await server.getWorker<{ DB: { prepare(sql: string): { run(): Promise<unknown> } } }>().getEnv()
	const migrations = new URL('../migrations/', import.meta.url)
	for (const file of readdirSync(migrations).sort()) {
		for (const statement of unstable_splitSqlQuery(readFileSync(new URL(file, migrations), 'utf8'))) await env.DB.prepare(statement).run()
	}
})

after(async () => {
	await server.close()
	fake.close()
})

type Init = { method?: string; body?: string; cookie?: string; key?: string; origin?: string }

function call(path: string, init: Init = {}) {
	const headers: Record<string, string> = {}
	if (init.cookie) headers.Cookie = init.cookie
	if (init.key) headers.Authorization = `Bearer ${init.key}`
	if (init.origin) headers.Origin = init.origin
	return server.fetch(SITE + path, { method: init.method, body: init.body, headers, redirect: 'manual' })
}

const cookies = (res: { headers: Headers }) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')

/** signIn signs a person in through the fake Hack Club Auth and returns their session cookie. */
async function signIn(person: string): Promise<string> {
	const start = await call('/auth/hca')
	const state = new URL(start.headers.get('Location')!).searchParams.get('state')
	const done = await call(`/auth/callback?code=code-${person}&state=${state}`, { cookie: cookies(start) })
	assert.equal(done.headers.get('Location'), '/dashboard')
	return cookies(done)
}

async function me(cookie: string) {
	return (await (await call('/api/me', { cookie })).json()) as { name: string; slack_id: string; handle: string; profile_public: boolean; admin: boolean; level: number | null; ban: { until: null } | null; api_key: string; computers: { id: string; cloud: boolean }[] }
}

async function reports(cookie: string, query = '') {
	const res = await call('/api/report' + query, { cookie })
	assert.equal(res.status, 200)
	return ((await res.json()) as { computers: { id: string; report: { report: unknown } }[] }).computers
}

/** computer is a teardrop install: a signing key, and reports signed the way the CLI signs them. */
function computer({ publicKey, privateKey }: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync('ed25519')) {
	const account = publicKey.export({ format: 'jwk' }).x!
	return (report: object, generatedAt = Date.now(), version = 'v0.0.1') => {
		const payload = JSON.stringify({
			account,
			generated_at: new Date(generatedAt).toISOString(),
			expires_at: new Date(generatedAt + 7 * DAY).toISOString(),
			since: '365d',
			teardrop_version: version,
			report,
		})
		return JSON.stringify({ v: 1, payload, key: sign(null, Buffer.from(payload), privateKey).toString('base64url') })
	}
}

const block = (end: number, name = 'site') => ({
	project: { key: name, name },
	start: new Date(end - 600_000).toISOString(),
	end: new Date(end).toISOString(),
	engaged_seconds: 600,
})

test('every answer says it may not be framed or have its type guessed', async () => {
	const cookie = await signIn('framed')
	for (const [path, as] of [['/', ''], ['/login', ''], ['/dashboard', cookie], ['/api/me', cookie], ['/api/me', ''], ['/nowhere', cookie]] as const) {
		const res = await call(path, { cookie: as })
		assert.deepEqual([res.headers.get('X-Frame-Options'), res.headers.get('X-Content-Type-Options')], ['DENY', 'nosniff'], `${path} ${res.status}`)
	}
})

test('pages and data need an account', async () => {
	for (const page of ['/dashboard', '/settings.html', '/review/']) {
		const res = await call(page)
		assert.equal(res.status, 302, page)
		assert.equal(res.headers.get('Location'), `/login?next=${encodeURIComponent(page)}`)
	}
	assert.equal((await call('/api/me')).status, 401)
	assert.equal((await call('/api/report')).status, 401)
	assert.equal((await call('/login')).status, 200)
})

test('a server without its secrets says so', async () => {
	const bare = createTestHarness({
		// The rest are given as empty, so a .dev.vars file on this computer doesn't supply them.
		workers: [{ configPath: new URL('../wrangler.jsonc', import.meta.url), vars: { DEV_LOGIN: '' }, secrets: { SESSION_SECRET: 'x', HCA_CLIENT_ID: '', HCA_CLIENT_SECRET: '', ADMINS: '' } }],
	})
	try {
		await bare.listen()
		const res = await bare.fetch(SITE + '/login')
		assert.equal(res.status, 503)
		assert.match(await res.text(), /HCA_CLIENT_ID, HCA_CLIENT_SECRET, ADMINS/)
	} finally {
		await bare.close()
	}
})

test('MIN_VERSION sends older and unversioned clients to teardrop update', async () => {
	const site = createTestHarness({
		workers: [{ configPath: new URL('../wrangler.jsonc', import.meta.url), vars: { DEV_LOGIN: 'UDEV', MIN_VERSION: 'v0.6.0' }, secrets: { SESSION_SECRET: 'x', HCA_CLIENT_ID: 'a', HCA_CLIENT_SECRET: 'b', ADMINS: '' } }],
	})
	try {
		await site.listen()
		const env = await site.getWorker<{ DB: { prepare(sql: string): { run(): Promise<unknown> } } }>().getEnv()
		const migrations = new URL('../migrations/', import.meta.url)
		for (const file of readdirSync(migrations).sort()) {
			for (const statement of unstable_splitSqlQuery(readFileSync(new URL(file, migrations), 'utf8'))) await env.DB.prepare(statement).run()
		}
		const { api_key: key } = (await (await site.fetch('/api/me')).json()) as { api_key: string }
		const whoami = (version?: string) =>
			site.fetch('/api/v1/whoami', { headers: { Authorization: `Bearer ${key}`, ...(version ? { 'X-Teardrop-Version': version } : {}) } })
		// v0.10.0 is newer than v0.6.0, though it sorts before it as text.
		for (const version of ['v0.6.0', 'v0.10.0', 'v1.0.0', 'dev']) assert.equal((await whoami(version)).status, 200, version)
		for (const version of ['v0.5.9', 'v0.0.1', undefined, 'v0.6']) {
			const res = await whoami(version)
			assert.equal(res.status, 426, String(version))
			assert.match(await res.text(), /teardrop v0\.6\.0 or newer\. Run `teardrop update`/)
		}
		// The key is checked first, so a stranger learns nothing about the version.
		assert.equal((await site.fetch('/api/v1/whoami', { headers: { Authorization: 'Bearer tdk_nope' } })).status, 401)
	} finally {
		await site.close()
	}
})

test('DEV_LOGIN signs visitors in on localhost only', async () => {
	const local = (await (await server.fetch('/api/me')).json()) as { slack_id: string }
	assert.equal(local.slack_id, 'UDEV')
	assert.equal((await call('/api/me')).status, 401)
})

test('signing in creates one account per person and keeps its sync key', async () => {
	const first = await me(await signIn('ada'))
	assert.deepEqual([first.slack_id, first.admin], ['UADA', false])
	assert.match(first.api_key, /^tdk_/)
	assert.equal((await me(await signIn('ada'))).api_key, first.api_key)
	assert.notEqual((await me(await signIn('grace'))).api_key, first.api_key)

	const cookie = await signIn('ada')
	assert.equal((await call('/logout', { method: 'POST', cookie })).status, 403, 'another site cannot sign someone out')
	const out = await call('/logout', { method: 'POST', cookie, origin: SITE })
	assert.deepEqual([out.headers.get('Location'), cookies(out)], ['/', 'teardrop_session='])

	const page = await call('/dashboard', { cookie })
	const html = await page.text()
	assert.match(html, /<html[^>]* data-hosted/)
	assert.match(html, /&lt;b&gt;ada&lt;\/b&gt;/, 'the name from Hack Club Auth is shown as text, not markup')
	assert.doesNotMatch(html, /data-admin/)
	assert.match(html, /id="account-initial"[^>]*>b</, 'the avatar shows the name\'s first letter')
})

test('a sign-in that this browser did not start is refused', async () => {
	const start = await call('/auth/hca')
	const forged = await call('/auth/callback?code=code-ada&state=someone-elses', { cookie: cookies(start) })
	assert.equal(forged.headers.get('Location'), '/login?error=expired')
	assert.doesNotMatch(cookies(forged), /teardrop_session=[^;]/)
	const noCookie = await call(`/auth/callback?code=code-ada&state=${new URL(start.headers.get('Location')!).searchParams.get('state')}`)
	assert.equal(noCookie.headers.get('Location'), '/login?error=expired')
})

test('a synced report is stored exactly and replaced only by a newer one', async () => {
	const cookie = await signIn('sync')
	const { api_key: key } = await me(cookie)
	const signed = computer()
	const now = Date.now()

	// Larger than one stored piece, with characters that take two UTF-16 units.
	const big = { engaged_seconds: 1200, blocks: Array.from({ length: 9000 }, (_, i) => block(now - i * 1000, `🙂 ${'é'.repeat(40)} ${i}`)) }
	const body = signed(big, now - 2000)
	assert.ok(JSON.parse(body).payload.length > 1_300_000)
	const res = await call('/api/v1/reports', { method: 'POST', body, key })
	assert.equal(res.status, 200, await res.clone().text())
	const { account, url } = (await res.json()) as { account: string; url: string }
	assert.match(account, /^td-[0-9a-f]{12}$/)
	assert.equal(url, `${SITE}/dashboard`)
	let stored = await reports(cookie)
	assert.deepEqual(stored.map((c) => c.id), [account])
	assert.deepEqual(stored[0]!.report, JSON.parse(JSON.parse(body).payload))

	const older = await call('/api/v1/reports', { method: 'POST', body: signed({ engaged_seconds: 1, blocks: [] }, now - 5000), key })
	assert.equal(older.status, 409)
	const newer = await call('/api/v1/reports', { method: 'POST', body: signed({ engaged_seconds: 600, blocks: [block(now - 1000)] }, now), key })
	assert.equal(newer.status, 200)
	stored = await reports(cookie)
	assert.equal(stored.length, 1)
	assert.deepEqual(stored[0]!.report.report, { engaged_seconds: 600, blocks: [block(now - 1000)] })
	assert.equal((await me(cookie)).computers.length, 1)
})

test('reports that fail teardrop\'s checks are refused', async () => {
	const cookie = await signIn('strict')
	const { api_key: key } = await me(cookie)
	const signed = computer()
	const now = Date.now()
	const post = (body: string, k = key) => call('/api/v1/reports', { method: 'POST', body, key: k })

	const good = signed({ engaged_seconds: 600, blocks: [block(now - 1000)] })
	assert.equal((await post(good, '')).status, 401)
	assert.equal((await post(good, 'tdk_notarealkey')).status, 401)
	const edited = JSON.parse(good)
	edited.payload = edited.payload.replace('"engaged_seconds":600', '"engaged_seconds":999')
	assert.equal((await post(JSON.stringify(edited))).status, 400)
	assert.equal((await post(signed({ blocks: [] }, now - 8 * DAY))).status, 400, 'expired')
	assert.equal((await post(signed({ blocks: [] }, now + DAY))).status, 400, 'made in the future')
	assert.equal((await post(signed({ blocks: [block(now + 3600_000)] }))).status, 400, 'activity after it was made')
	assert.equal((await post('{"v":1}')).status, 400)
	assert.deepEqual(await reports(cookie), [])

	// A computer's hours count for one person.
	assert.equal((await post(good)).status, 200)
	const other = await me(await signIn('other'))
	const again = await post(signed({ engaged_seconds: 600, blocks: [] }, now + 1000), other.api_key)
	assert.equal(again.status, 409)
	assert.deepEqual(other.computers, [])
})

test('settings: upload, new key, and removing a computer', async () => {
	const cookie = await signIn('settings')
	const signed = computer()
	const body = signed({ engaged_seconds: 600, blocks: [block(Date.now() - 1000)] })

	assert.equal((await call('/api/reports', { method: 'POST', body, cookie })).status, 403, 'no Origin')
	assert.equal((await call('/api/reports', { method: 'POST', body, cookie, origin: 'http://evil.example' })).status, 403)
	const up = await call('/api/reports', { method: 'POST', body, cookie, origin: SITE })
	assert.equal(up.status, 200)
	const { computer: id } = (await up.json()) as { computer: string }

	const { api_key: oldKey } = await me(cookie)
	const rotated = (await (await call('/api/key', { method: 'POST', cookie, origin: SITE })).json()) as { api_key: string }
	assert.notEqual(rotated.api_key, oldKey)
	const fresh = signed({ engaged_seconds: 700, blocks: [] }, Date.now() + 1000)
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: fresh, key: oldKey })).status, 401)
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: fresh, key: rotated.api_key })).status, 200)

	const stranger = await signIn('stranger')
	assert.equal((await call(`/api/computers/${id}`, { method: 'DELETE', cookie: stranger, origin: SITE })).status, 404)
	assert.equal((await reports(cookie)).length, 1)
	assert.equal((await call(`/api/computers/${id}`, { method: 'DELETE', cookie, origin: SITE })).status, 200)
	assert.deepEqual(await reports(cookie), [])
	assert.deepEqual((await me(cookie)).computers, [])
})

test('only reviewers see other people, in the review app', async () => {
	const member = await signIn('member')
	const admin = await signIn('admin')
	assert.deepEqual([(await me(admin)).admin, (await me(admin)).level, (await me(member)).level], [true, 0, null])
	await call('/api/reports', { method: 'POST', body: computer()({ engaged_seconds: 600, blocks: [] }), cookie: member, origin: SITE })

	assert.equal((await call('/review/', { cookie: member })).headers.get('Location'), '/dashboard')
	assert.equal((await call('/api/review/people', { cookie: member })).status, 403)
	assert.equal((await call('/api/report?user=1', { cookie: member })).status, 403)

	assert.match(await (await call('/review/', { cookie: admin })).text(), /<html[^>]* data-staff[\s\S]*<title>teardrop review</)
	// Only a reviewer's pages are marked to show the Review links.
	for (const page of ['/', '/dashboard', '/settings']) {
		assert.match(await (await call(page, { cookie: admin })).text(), /<html[^>]* data-staff[\s\S]*class="staff-only">Review</, page)
		assert.doesNotMatch(await (await call(page, { cookie: member })).text(), /<html[^>]* data-staff/, page)
	}
	// The addresses the review pages had, and ones someone would guess, lead to the app.
	for (const guess of ['/review', '/admin', '/reviewer.html', '/people', '/people.html']) assert.equal((await call(guess, { cookie: admin })).headers.get('Location'), '/review/', guess)
	assert.equal((await call('/person?slack=UMEMBER', { cookie: admin })).headers.get('Location'), '/review/#/person/UMEMBER')
	assert.equal((await call('/person.html?id=7', { cookie: admin })).headers.get('Location'), '/review/#/person/id%3A7')
	const { people } = (await (await call('/api/review/people', { cookie: admin })).json()) as { people: { id: number; slack_id: string; engaged_seconds: number; computers: number }[] }
	const row = people.find((p) => p.slack_id === 'UMEMBER')!
	assert.deepEqual([row.engaged_seconds, row.computers], [600, 1])
	assert.equal((await reports(admin, `?user=${row.id}`)).length, 1)
	for (const id of ['999999', 'x', '1e3']) assert.equal((await call(`/api/report?user=${id}`, { cookie: admin })).status, 404, id)
})

type LogRow = { event: string; computer_id: string; refusal: string; flagged: number; engaged_seconds: number; past_added_seconds: number | null; findings: string[]; remarks: string[] }
type Review = {
	person: { id: number; slack_id: string; deleted_at: number | null }
	computers: { id: string }[]
	counts: { entries: number; flagged: number; refused: number }
	unchecked_seconds: number
	impossible_days: string[]
	log: LogRow[]
	more: number | null
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

test('reviewers look a person up by Slack ID and read their log', async () => {
	const admin = await signIn('admin')
	const cookie = await signIn('logged')
	const { api_key: key } = await me(cookie)
	const review = async (query = 'slack=ulogged') => {
		const res = await call(`/api/review/person?${query}`, { cookie: admin })
		assert.equal(res.status, 200, await res.clone().text())
		return (await res.json()) as Review
	}
	const signed = computer()
	const now = Date.now()
	const days = (totals: Record<number, number>) => Object.entries(totals).map(([ago, engaged_seconds]) => ({ date: day(now - Number(ago) * DAY), engaged_seconds }))
	const sync = async (report: object, generatedAt: number) => {
		const res = await call('/api/v1/reports', { method: 'POST', body: signed(report, generatedAt), key })
		assert.equal(res.status, 200, await res.clone().text())
		return (await review()).log[0]!
	}

	// Only admins, and only for people who exist. A Slack ID no one has signed in with has only its access and bans.
	assert.equal((await call('/api/review/person?slack=ULOGGED', { cookie })).status, 403)
	assert.equal((await call('/review/', { cookie })).headers.get('Location'), '/dashboard')
	assert.equal((await call('/review/', { cookie: admin })).status, 200)
	for (const query of ['id=999999', 'id=1e3', '']) assert.equal((await call(`/api/review/person?${query}`, { cookie: admin })).status, 404, query)
	assert.equal(((await (await call('/api/review/person?slack=UNOBODY', { cookie: admin })).json()) as { signed_in: boolean }).signed_in, false)
	assert.deepEqual([(await review()).person.slack_id, (await review()).log], ['ULOGGED', []])

	// A first report has nothing to be compared with: noted, not flagged.
	let row = await sync({ engaged_seconds: 4200, blocks: [], days: days({ 10: 3600, 4: 600 }) }, now - 3 * DAY)
	assert.deepEqual([row.event, row.flagged, row.findings.length, row.engaged_seconds], ['sync', 0, 0, 4200])
	assert.equal(row.remarks[0], 'First sync: 1h 10m of earlier history, unchecked.')
	assert.equal((await review()).unchecked_seconds, 4200)

	// Three days later: today's work, and half an hour that moved to the day
	// before (a change of time zone). Nothing wrong.
	row = await sync({ engaged_seconds: 6000, blocks: [], days: days({ 11: 1800, 10: 1800, 4: 600, 0: 1800 }) }, now - 3000)
	assert.deepEqual([row.flagged, row.past_added_seconds, row.findings], [0, 0, []])

	// An hour appears on a day that was long over.
	row = await sync({ engaged_seconds: 9600, blocks: [], days: days({ 11: 1800, 10: 5400, 4: 600, 0: 1800 }) }, now - 2000)
	assert.deepEqual([row.flagged, row.past_added_seconds], [1, 3600])
	assert.match(row.findings.join(' '), /1h 00m to days that were already over/)
	assert.match(row.findings.join(' '), /only 0m had passed/)

	// More time today than has passed since the last report.
	row = await sync({ engaged_seconds: 9600 + 7200, blocks: [], days: days({ 11: 1800, 10: 5400, 4: 600, 0: 9000 }) }, now - 1000)
	assert.deepEqual([row.flagged, row.past_added_seconds, row.findings.length], [1, 0, 1])
	assert.match(row.findings[0]!, /Added 2h 00m of engaged time, but only 0m had passed/)

	// Refused reports are in the log too. An edited one is flagged; a late one is not.
	const edited = JSON.parse(signed({ engaged_seconds: 600, blocks: [] }, now))
	edited.payload = edited.payload.replace('"engaged_seconds":600', '"engaged_seconds":99999')
	assert.equal((await call('/api/reports', { method: 'POST', body: JSON.stringify(edited), cookie, origin: SITE })).status, 400)
	row = (await review()).log[0]!
	assert.deepEqual([row.event, row.flagged, row.engaged_seconds], ['upload', 1, 99999])
	assert.match(row.refusal, /changed after it was made/)
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: signed({ blocks: [] }, now - 5000), key })).status, 409)
	row = (await review()).log[0]!
	assert.deepEqual([row.flagged, row.refusal], [0, 'The server already has a newer report from this computer.'])

	// Removing a computer is logged, and doesn't give it a clean start.
	const id = (await review()).computers[0]!.id
	assert.equal((await call(`/api/computers/${id}`, { method: 'DELETE', cookie, origin: SITE })).status, 200)
	row = (await review()).log[0]!
	assert.deepEqual([row.event, row.computer_id, row.engaged_seconds], ['remove', id, 16800])
	row = await sync({ engaged_seconds: 16800 + 36000, blocks: [], days: days({ 5: 36000 + 16800 }) }, now)
	assert.equal(row.flagged, 1)
	assert.match(row.findings.join(' '), /Added 10h 00m of engaged time/)
	assert.match(row.remarks.join(' '), /removed and added again/)

	// The counts, and the log narrowed to what was flagged or refused.
	const all = await review()
	assert.deepEqual(all.counts, { entries: 8, flagged: 4, refused: 2 })
	assert.equal(all.unchecked_seconds, 4200)
	assert.equal((await review('slack=ULOGGED&show=flagged')).log.length, 4)
	assert.deepEqual((await review('slack=ULOGGED&show=refused')).log.map((r) => r.flagged), [0, 1])
	assert.deepEqual((await review(`id=${all.person.id}`)).counts, all.counts)
	const { people } = (await (await call('/api/review/people', { cookie: admin })).json()) as { people: { slack_id: string; flagged: number }[] }
	assert.equal(people.find((p) => p.slack_id === 'ULOGGED')!.flagged, 4)

	// Two computers that together claim more than a day holds.
	const second = computer()
	const busy = { engaged_seconds: 14 * 3600, blocks: [], days: days({ 5: 14 * 3600 }) }
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: second(busy, now), key })).status, 200)
	const both = await review()
	assert.equal(both.log[0]!.flagged, 0)
	assert.equal(both.impossible_days.length, 1)
	assert.match(both.impossible_days[0]!, new RegExp(`^${day(now - 5 * DAY)}: their computers add up to 28h 40m`))

	// A day that left the report's window doesn't hide time added to a later
	// one, and a new version of teardrop is pointed out.
	const third = computer()
	const old = { engaged_seconds: 4200, blocks: [], days: days({ 20: 3600, 9: 600 }) }
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: third(old, now - 4 * DAY), key })).status, 200)
	const slid = { engaged_seconds: 4200, blocks: [], days: days({ 9: 4200 }) }
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: third(slid, now, 'v0-next'), key })).status, 200)
	row = (await review()).log[0]!
	assert.deepEqual([row.flagged, row.past_added_seconds], [1, 3600])
	assert.match(row.remarks.join(' '), /teardrop changed from v0.0.1 to v0-next.*teardrop v0-next, which is not a released version/)

	// Deleting the account empties it, and leaves the log for reviewers.
	const before = await review()
	assert.equal(before.computers.length, 3)
	assert.equal((await call('/api/account', { method: 'DELETE', cookie, origin: SITE })).status, 200)
	assert.equal((await call('/api/me', { cookie })).status, 401)
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: signed({ blocks: [] }, now + 500), key })).status, 401)
	const left = await review()
	assert.ok(left.person.deleted_at! >= now)
	assert.deepEqual([left.person.id, left.computers], [before.person.id, []])
	assert.deepEqual(left.log.slice(0, 4).map((r) => r.event), ['delete', 'remove', 'remove', 'remove'])
	assert.deepEqual(left.counts, { ...before.counts, entries: before.counts.entries + 4 })
	const listed = ((await (await call('/api/review/people', { cookie: admin })).json()) as { people: { slack_id: string; flagged: number; computers: number; deleted_at: number | null }[] }).people.find((p) => p.slack_id === 'ULOGGED')!
	assert.deepEqual([listed.flagged, listed.computers, Boolean(listed.deleted_at)], [before.counts.flagged, 0, true])

	// Signing in again reopens the same account: empty, with a new sync key
	// and its log. A computer that comes back is held to what it had.
	const back = await me(await signIn('logged'))
	assert.notEqual(back.api_key, key)
	assert.deepEqual(back.computers, [])
	assert.equal((await review()).person.deleted_at, null)
	const more = { engaged_seconds: 16800 + 36000 + 7200, blocks: [], days: days({ 5: 16800 + 36000 + 7200 }) }
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: signed(more, now + 1000), key: back.api_key })).status, 200)
	row = (await review()).log[0]!
	assert.equal(row.flagged, 1)
	assert.match(row.findings.join(' '), /Added 2h 00m of engaged time/)
})

type Change = [string, number, number]
type Detail = { bytes: number; blocks: number; first_block: number | null; last_block: number | null; active_days: number; project_count: number; prompts: number; skipped_prompts: number; tokens_in: number; tokens_out: number; lines_added: number; lines_removed: number; lines_kept: number; tools: string[]; full?: boolean; days?: Change[]; projects?: Change[] }

test('a log entry says what the report held and what changed, and a computer has a history', async () => {
	const admin = await signIn('admin')
	const cookie = await signIn('detailed')
	const { api_key: key } = await me(cookie)
	const now = Date.now()
	const review = async (query = '') => {
		const res = await call(`/api/review/person?slack=UDETAILED${query}`, { cookie: admin })
		assert.equal(res.status, 200, await res.clone().text())
		return (await res.json()) as { counts: { entries: number }; log: (LogRow & { detail: Detail | null })[] }
	}
	const project = (name: string, engaged_seconds: number, more = {}) => ({ project: { key: `/home/x/${name}`, name }, engaged_seconds, ...more })
	const days = (totals: Record<number, number>) => Object.entries(totals).map(([ago, engaged_seconds]) => ({ date: day(now - Number(ago) * DAY), engaged_seconds }))
	const laptop = computer()
	const send = async (signed: string) => {
		const res = await call('/api/v1/reports', { method: 'POST', body: signed, key })
		assert.equal(res.status, 200, await res.clone().text())
		return ((await res.json()) as { account: string }).account
	}

	// A first report: what it held, and every day and project in it.
	const work = { prompts: 5, tokens_in: 1000, tokens_out: 200, lines_added: 30, lines_removed: 4, lines_kept: 20 }
	const blocks = [
		{ ...block(now - 4 * DAY, 'notes'), ...work, tools: ['codex', 'claude-code'] },
		{ ...block(now - 10 * DAY, 'site'), prompts: 3, tokens_in: 500, tools: ['codex'] },
	]
	const first = laptop({ engaged_seconds: 4200, blocks, projects: [project('site', 3600, { noise_prompts: 2, repeat_prompts: 1 }), project('notes', 600)], days: days({ 10: 3600, 4: 600 }) }, now - 5000)
	const id = await send(first)
	let detail = (await review()).log[0]!.detail!
	const { days: listed, projects: named, ...held } = detail
	assert.deepEqual(held, {
		bytes: Buffer.byteLength(JSON.parse(first).payload),
		blocks: 2,
		first_block: now - 10 * DAY - 600_000,
		last_block: now - 4 * DAY,
		active_days: 2,
		project_count: 2,
		prompts: 8,
		skipped_prompts: 3,
		tokens_in: 1500,
		tokens_out: 200,
		lines_added: 30,
		lines_removed: 4,
		lines_kept: 20,
		tools: ['claude-code', 'codex'],
		full: true,
	})
	assert.deepEqual(listed, [[day(now - 4 * DAY), 0, 600], [day(now - 10 * DAY), 0, 3600]])
	assert.deepEqual(named, [['site', 0, 3600], ['notes', 0, 600]])

	// The next one: only what changed, the largest change first.
	await send(laptop({ engaged_seconds: 6300, blocks: [], projects: [project('site', 3600), project('notes', 2400), project('cli', 300)], days: days({ 10: 3600, 4: 600, 0: 2100 }) }, now - 4000))
	detail = (await review()).log[0]!.detail!
	assert.deepEqual([detail.full, detail.days, detail.projects], [false, [[day(now), 0, 2100]], [['notes', 600, 2400], ['cli', 0, 300]]])

	// A day that left the report's window is not a change. Its project's time going is.
	await send(laptop({ engaged_seconds: 2700, blocks: [], projects: [project('notes', 2400), project('cli', 300)], days: days({ 4: 600, 0: 2100 }) }, now - 3000))
	detail = (await review()).log[0]!.detail!
	assert.deepEqual([detail.days, detail.projects], [[], [['site', 3600, 0]]])

	// A refused report still says what it claimed to hold.
	const edited = JSON.parse(laptop({ engaged_seconds: 600, blocks: [block(now - DAY)] }, now - 2000))
	edited.payload = edited.payload.replace('"engaged_seconds":600', '"engaged_seconds":99999')
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: JSON.stringify(edited), key })).status, 400)
	const refused = (await review()).log[0]!
	assert.deepEqual([refused.flagged, refused.detail!.blocks, refused.detail!.days], [1, 1, undefined])

	// One computer's history, apart from another's.
	const desktop = computer()
	const latest = desktop({ engaged_seconds: 600, blocks: [block(now - DAY, 'game')], days: days({ 1: 600 }) }, now - 1000)
	const other = await send(latest)
	assert.deepEqual((await review()).log.map((r) => r.computer_id), [other, id, id, id, id])
	assert.deepEqual((await review(`&computer=${id}`)).log.map((r) => r.computer_id), [id, id, id, id])
	assert.deepEqual((await review(`&computer=${other}&show=flagged`)).log, [])
	assert.deepEqual((await review('&computer=td-000000000000')).log, [])
	// Without totals per project, a report's work blocks say which projects it had.
	assert.deepEqual((await review(`&computer=${other}`)).log[0]!.detail!.projects, [['game', 0, 600]])

	// The latest report of a computer in full, and the whole log, for admins only.
	const full = await call(`/api/review/report?computer=${other}`, { cookie: admin })
	assert.equal(full.status, 200)
	const stored = (await full.json()) as { id: string; signature: string; report: unknown }
	assert.deepEqual([stored.id, stored.signature, stored.report], [other, JSON.parse(latest).key, JSON.parse(JSON.parse(latest).payload)])
	assert.equal((await call('/api/review/report?computer=td-000000000000', { cookie: admin })).status, 404)
	const download = await call('/api/review/log?slack=UDETAILED', { cookie: admin })
	assert.match(download.headers.get('Content-Disposition')!, /attachment; filename="teardrop-log-\d+\.json"/)
	const whole = (await download.json()) as { log: (LogRow & { detail: Detail | null })[] }
	assert.deepEqual([whole.log.length, whole.log.at(-1)!.detail!.projects], [5, [['site', 0, 3600], ['notes', 0, 600]]])
	for (const path of [`/api/review/report?computer=${other}`, '/api/review/log?slack=UDETAILED']) assert.equal((await call(path, { cookie })).status, 403, path)

	// Deleting the account takes the project names out of the log and leaves the rest.
	assert.equal((await call('/api/account', { method: 'DELETE', cookie, origin: SITE })).status, 200)
	const kept = (await review()).log.filter((r) => r.event === 'sync')
	assert.equal(kept.length, 5)
	for (const row of kept) assert.equal(row.detail!.projects, undefined)
	assert.deepEqual([kept.at(-1)!.detail!.days, kept.at(-1)!.detail!.blocks], [listed, 2])
})

test('every report is kept in full, refused ones too, until the account is deleted', async () => {
	const admin = await signIn('admin')
	const cookie = await signIn('keeper')
	const { api_key: key } = await me(cookie)
	const now = Date.now()
	const post = (body: string) => call('/api/v1/reports', { method: 'POST', body, key })
	const review = async () => {
		const res = await call('/api/review/person?slack=UKEEPER', { cookie: admin })
		return (await res.json()) as { person: { id: number }; log: (LogRow & { id: number; has_report: boolean })[] }
	}
	const kept = async (entry: number) => {
		const res = await call(`/api/review/report?entry=${entry}`, { cookie: admin })
		return res.status === 200 ? ((await res.json()) as { entry: number; id: string; refusal: string; signature: string; report: unknown }) : res.status
	}
	const bucket = (await server.getWorker<{ REPORTS: { list(options: { prefix: string }): Promise<{ objects: { key: string }[] }> } }>().getEnv()).REPORTS
	const files = async (prefix: string) => (await bucket.list({ prefix })).objects.map((o) => o.key)

	// Someone else's reports, which nothing below may touch.
	const { api_key: otherKey } = await me(await signIn('bystander'))
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: computer()({ engaged_seconds: 600, blocks: [block(now - 1000)] }), key: otherKey })).status, 200)
	const others = (await files('')).length

	const signed = computer()
	const first = signed({ engaged_seconds: 600, blocks: [block(now - 9000, '🙂 café')] }, now - 3000)
	const second = signed({ engaged_seconds: 1200, blocks: [block(now - 9000, '🙂 café'), block(now - 4000, 'site')] }, now - 2000)
	// A report changed after it was signed is refused, and kept as it arrived.
	const forged = JSON.parse(signed({ engaged_seconds: 1800, blocks: [block(now - 1500, 'forged')] }, now - 1000))
	forged.payload = forged.payload.replace('"engaged_seconds":1800', '"engaged_seconds":180000')
	assert.deepEqual([(await post(first)).status, (await post(second)).status, (await post(JSON.stringify(forged))).status], [200, 200, 400])
	// A file that is not a teardrop report is refused and not kept.
	assert.equal((await post('{"private":"notes"}')).status, 400)

	const { person, log } = await review()
	assert.deepEqual(log.map((r) => r.has_report), [false, true, true, true])
	const [stray, refused, newer, older] = log.map((r) => r.id) as [number, number, number, number]
	const id = log[1]!.computer_id
	// Each entry opens its own report, not the computer's latest.
	for (const [entry, sent, refusal] of [[older, first, ''], [newer, second, ''], [refused, JSON.stringify(forged), log[1]!.refusal]] as const) {
		const got = await kept(entry)
		assert.notEqual(typeof got, 'number', `entry ${entry}`)
		if (typeof got === 'number') continue
		assert.deepEqual([got.entry, got.id, got.refusal, got.signature, got.report], [entry, id, refusal, JSON.parse(sent).key, JSON.parse(JSON.parse(sent).payload)])
	}
	assert.match(log[1]!.refusal, /changed after it was made/)
	assert.deepEqual([await kept(stray), await kept(999999), (await call('/api/review/report?entry=1e3', { cookie: admin })).status], [404, 404, 404])
	assert.equal((await call(`/api/review/report?entry=${older}`, { cookie })).status, 403, 'not even their own')
	assert.equal((await files(`${person.id}/${id}/`)).length, 3)

	// Removing the computer leaves its reports with reviewers.
	assert.equal((await call(`/api/computers/${id}`, { method: 'DELETE', cookie, origin: SITE })).status, 200)
	assert.equal(typeof (await kept(older)), 'object')

	// Deleting the account deletes them, and no one else's.
	assert.equal((await call('/api/account', { method: 'DELETE', cookie, origin: SITE })).status, 200)
	assert.deepEqual([await kept(older), await kept(newer), await kept(refused)], [404, 404, 404])
	assert.ok((await review()).log.every((r) => !r.has_report))
	assert.deepEqual([await files(`${person.id}/`), (await files('')).length], [[], others])
})

test('events from Amp\'s cloud are kept, and a cloud thread reads them back with the key to sign its count', async () => {
	const cookie = await signIn('cloudy')
	const { api_key: key } = await me(cookie)
	const { api_key: otherKey } = await me(await signIn('stranger'))
	const now = Date.now()
	// sim is larger than a JavaScript number holds exactly, and must come back as sent.
	const line = (ago: number, event: string, more = '') => `{"t":"${new Date(now - ago).toISOString()}","tool":"amp","event":"${event}","session":"T-1"${more}}`
	const prompt = line(60_000, 'agent.start', ',"human":true,"git":"github.com/kid/site","judged":6,"real":6,"sim":18446744073709551615')
	const done = line(30_000, 'agent.end')
	const send = async (body: string, as = key) => {
		const res = await call('/api/v1/events', { method: 'POST', body, key: as })
		return res.status === 200 ? ((await res.json()) as { stored: number }).stored : res.status
	}
	const read = async (after = 0, as = key) => {
		const res = await call(`/api/v1/cloud?after=${after}`, { key: as })
		assert.equal(res.status, 200, await res.clone().text())
		return (await res.json()) as { key: string; last: number; lines: string[] }
	}

	assert.equal(await send(prompt, ''), 401, 'no sync key')
	assert.equal((await call('/api/v1/cloud')).status, 401, 'no sync key')
	const junk = ['not json', '{"tool":"claude-code","session":"T-1","t":"2026-01-01T00:00:00Z","event":"Stop"}', line(-3600_000, 'agent.end'), line(40 * DAY, 'agent.end'), ''].join('\n')
	assert.deepEqual([await send([prompt, junk, done].join('\n')), await send(prompt + '\n')], [2, 0], 'only Amp events from a sensible time, each once')
	assert.equal(await send(line(1000, 'agent.end', `,"cwd":"${'x'.repeat(600_000)}"`)), 413)

	// Reading leaves them there, because the next thread starts on a new machine. No one else gets them.
	const first = await read()
	assert.deepEqual(first.lines, [prompt, done])
	assert.deepEqual([(await read()).lines, (await read(0, otherKey)).lines], [[prompt, done], []])
	// A thread that has them asks only for what came after.
	assert.deepEqual((await read(first.last)).lines, [])
	const later = line(1000, 'agent.start', ',"human":true')
	assert.equal(await send(later), 1)
	const next = await read(first.last)
	assert.deepEqual([next.lines, next.last > first.last], [[later], true])

	// Every thread of one person signs with the same key, which a new sync key doesn't change.
	const rotated = (await (await call('/api/key', { method: 'POST', cookie, origin: SITE })).json()) as { api_key: string }
	assert.equal((await call('/api/v1/cloud', { key })).status, 401, 'the old sync key')
	const again = await read(0, rotated.api_key)
	assert.deepEqual([again.key, again.lines.length], [first.key, 3])
	assert.notEqual((await read(0, otherKey)).key, first.key)

	// What a thread counts is stored like any computer's report, and the person's settings say which computer is their cloud threads.
	const seed = Buffer.from(first.key, 'base64url')
	assert.equal(seed.length, 32)
	const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
	const cloud = computer({ publicKey: createPublicKey(privateKey), privateKey })
	const laptop = computer()
	for (const signed of [cloud, laptop]) {
		const res = await call('/api/v1/reports', { method: 'POST', body: signed({ engaged_seconds: 600, blocks: [block(now - 1000)] }), key: rotated.api_key })
		assert.equal(res.status, 200, await res.clone().text())
	}
	const mine = (await me(cookie)).computers
	assert.deepEqual(mine.map((c) => c.cloud).sort(), [false, true])

	// A turn that ends in one thread earns minutes from before the count another
	// thread just made, so a cloud count isn't held to the clock as a computer's
	// is. Time added to days that were over is flagged for both.
	const admin = await signIn('admin')
	const { slack_id } = await me(cookie)
	const sync = async (signed: ReturnType<typeof computer>, engaged_seconds: number, days: Record<string, number>) => {
		const report = { engaged_seconds, blocks: [block(now - 1000)], days: Object.entries(days).map(([date, engaged_seconds]) => ({ date, engaged_seconds })) }
		const res = await call('/api/v1/reports', { method: 'POST', body: signed(report), key: rotated.api_key })
		assert.equal(res.status, 200, await res.clone().text())
		return ((await (await call(`/api/review/person?slack=${slack_id}`, { cookie: admin })).json()) as Review).log[0]!
	}
	const today = { [day(now)]: 7800 }
	let row = await sync(laptop, 7800, today)
	assert.deepEqual([row.flagged, row.findings.length], [1, 1])
	assert.match(row.findings[0]!, /Added 2h 00m of engaged time/)
	row = await sync(cloud, 7800, today)
	assert.deepEqual([row.flagged, row.findings], [0, []])
	assert.match(row.remarks.join(' '), /Amp cloud threads/)
	row = await sync(cloud, 11400, { ...today, [day(now - 10 * DAY)]: 3600 })
	assert.deepEqual([row.flagged, row.past_added_seconds, row.findings.length], [1, 3600, 1])

	// teardrop v0.5.2 on a computer still asks to take the events, and is told there are none for it.
	assert.equal((await call('/api/v1/events?computer=td-aaaaaaaaaaaa&after=0', { key: rotated.api_key })).status, 404)

	// Events from before the year a report covers go when more arrive.
	const env = await server.getWorker<{ DB: { prepare(sql: string): { run(): Promise<unknown> } } }>().getEnv()
	await env.DB.prepare(`UPDATE relayed_events SET received_at = ${now - 367 * DAY} WHERE event = 'agent.end' AND session = 'T-1'`).run()
	const newest = line(500, 'agent.end')
	assert.equal(await send(newest, rotated.api_key), 1)
	assert.deepEqual((await read(0, rotated.api_key)).lines, [prompt, later, newest])
})

test('reviewers have levels, which decide what they read, whom they add and ban, and what their keys do', async () => {
	const superadmin = await signIn('admin')
	const [neo, rev, member] = [await signIn('neo'), await signIn('rev'), await signIn('plain')]
	const { api_key: memberKey } = await me(member)
	const review = (path: string, cookie: string, method = 'GET', body?: object) =>
		call(`/api/review${path}`, { method, cookie, origin: method === 'GET' ? undefined : SITE, body: body && JSON.stringify(body) })
	const status = async (...args: Parameters<typeof review>) => (await review(...args)).status
	const withKey = (path: string, key: string, method = 'GET', body?: object) => call(`/api/review${path}`, { method, key, body: body && JSON.stringify(body) })

	// Only those in ADMINS start with a place.
	assert.deepEqual([(await me(superadmin)).level, (await me(neo)).level, (await me(rev)).level], [0, null, null])
	for (const who of [neo, rev, member]) assert.equal(await status('/me', who), 403)
	assert.equal(await status('/me', ''), 401)

	// A superadmin adds people by Slack ID, as pasted from Slack, even before they sign in.
	assert.equal(await status('/team', superadmin, 'POST', { slack_id: ' <@uneo> ', level: 1, note: 'runs reviews' }), 200)
	assert.equal(await status('/team', superadmin, 'POST', { slack_id: 'UNOTYET', level: 2 }), 200)
	assert.equal(await status('/team', superadmin, 'POST', { slack_id: 'not an id', level: 2 }), 400)
	assert.equal(await status('/team', superadmin, 'POST', { slack_id: 'UREV', level: 3 }), 400)
	assert.equal(await status('/team', superadmin, 'POST', { slack_id: 'UADMIN', level: 2 }), 409, 'a superadmin is set in ADMINS')
	assert.equal((await call('/api/review/team', { method: 'POST', cookie: superadmin, body: '{"slack_id":"UREV","level":2}' })).status, 403, 'not from this site')
	assert.equal((await me(neo)).level, 1)

	// A neoadmin adds and removes reviewers, and no one at their own level or above.
	assert.equal(await status('/team', neo, 'POST', { slack_id: 'UREV', level: 2 }), 200)
	assert.equal(await status('/team', neo, 'POST', { slack_id: 'UOTHERNEO', level: 1 }), 403)
	assert.equal(await status('/team', superadmin, 'POST', { slack_id: 'UOTHERNEO', level: 1 }), 200)
	assert.equal(await status('/team', neo, 'POST', { slack_id: 'UOTHERNEO', level: 2 }), 403, 'demoting another neoadmin')
	for (const above of ['UOTHERNEO', 'UNEO', 'UADMIN']) assert.equal(await status(`/team/${above}`, neo, 'DELETE'), 403, above)
	assert.deepEqual([await status('/team/UNOTYET', neo, 'DELETE'), await status('/team/UNOTYET', neo, 'DELETE')], [200, 404])
	// A reviewer adds no one, and a member has no place at all.
	for (const who of [rev, member]) assert.equal(await status('/team', who, 'POST', { slack_id: 'UPLAIN', level: 2 }), 403)
	type Team = { superadmins: { slack_id: string }[]; reviewers: { slack_id: string; level: number; name: string | null; banned: number }[]; log: { action: string; slack_id: string; by_slack_id: string }[] }
	let team = (await (await review('/team', neo)).json()) as Team
	assert.deepEqual(team.superadmins.map((s) => s.slack_id), ['UADMIN', 'UOTHER'])
	assert.deepEqual(team.reviewers.map((r) => `${r.slack_id} ${r.level}`).sort(), ['UNEO 1', 'UOTHERNEO 1', 'UREV 2'])

	// A reviewer reads a person's total for each project and nothing else. A neoadmin reads everything.
	const laptop = computer()
	const report = (engaged_seconds: number) => ({
		engaged_seconds,
		blocks: [{ ...block(Date.now() - 1000), project: { key: '/home/kid/site', name: 'site' }, prompts: 3, lines_added: 40, lines_removed: 5 }],
		projects: [{ project: { key: '/home/kid/site', name: 'site' }, engaged_seconds: engaged_seconds - 1800 }, { project: { key: 'game', name: 'game' }, engaged_seconds: 1800 }],
	})
	const sync = async (engaged: number) => (await call('/api/v1/reports', { method: 'POST', body: laptop(report(engaged)), key: memberKey })).status
	assert.equal(await sync(5400), 200)
	const seen = (await (await review('/person?slack=uplain', rev)).json()) as { limited: boolean; projects: object[]; activity: { name: string; blocks: number[][] }[]; ban: { reason: string } | null }
	assert.deepEqual(Object.keys(seen).sort(), ['activity', 'ban', 'engaged_seconds', 'flagged_reports', 'limited', 'person', 'projects', 'synced_at'])
	// The graphs get each work block as numbers: its times, engaged seconds, prompts, tokens, and lines, and which computer sent it.
	const [drawn] = seen.activity
	assert.deepEqual([seen.activity.length, drawn!.name, drawn!.blocks.map((b) => [b[1]! - b[0]!, ...b.slice(2)])], [1, 'site', [[600_000, 600, 3, 0, 0, 40, 5, 0, 0]]])
	assert.deepEqual([seen.limited, seen.projects], [true, [{ name: 'site', engaged_seconds: 3600 }, { name: 'game', engaged_seconds: 1800 }]])
	assert.doesNotMatch(JSON.stringify(seen), /home\/kid|td-[0-9a-f]|"id"/)
	const full = (await (await review('/person?slack=UPLAIN', neo)).json()) as Review & { projects: { key: string }[]; bans: object[] }
	assert.deepEqual([full.log.length, full.computers.length, full.projects[0]!.key, full.bans], [1, 1, '/home/kid/site', []])
	// Account numbers count up, so a reviewer can't go through people by them.
	assert.deepEqual([await status(`/person?id=${full.person.id}`, rev), await status(`/person?id=${full.person.id}`, neo)], [404, 200])
	for (const path of ['/people', '/team', '/bans', '/log?slack=UPLAIN', `/report?computer=${full.computers[0]!.id}`]) {
		assert.deepEqual([await status(path, rev), await status(path, neo)], [403, 200], path)
	}
	assert.deepEqual([(await call(`/api/report?user=${full.person.id}`, { cookie: rev })).status, (await call(`/api/report?user=${full.person.id}`, { cookie: neo })).status], [403, 200])
	// The app's page and script are for reviewers of any level.
	assert.match(await (await call('/dashboard', { cookie: rev })).text(), /<html[^>]* data-staff[\s\S]*class="staff-only">Review</)
	assert.match(await (await call('/review/review.js', { cookie: rev })).text(), /api\/review/)
	assert.equal((await call('/review/review.js', { cookie: member })).headers.get('Location'), '/dashboard')

	// A reviewer makes keys, which act as they do. The key is shown once and not kept.
	assert.equal(await status('/keys', rev, 'POST', { name: ' ' }), 400)
	assert.equal(await status('/keys', member, 'POST', { name: 'bot' }), 403)
	const made = (await (await review('/keys', rev, 'POST', { name: 'bot' })).json()) as { id: number; key: string }
	assert.match(made.key, /^tdr_[A-Za-z0-9_-]{32}$/)
	const listed = (await (await review('/keys', rev)).json()) as { keys: { name: string; hint: string; key?: string; hash?: string }[] }
	assert.deepEqual(listed.keys.map((k) => [k.name, k.hint, k.key, k.hash]), [['bot', made.key.slice(0, 9), undefined, undefined]])
	assert.deepEqual(await (await withKey('/me', made.key)).json(), { name: '<b>rev</b>', slack_id: 'UREV', level: 2, by_key: true })
	assert.equal(((await (await withKey('/person?slack=UPLAIN', made.key)).json()) as { limited: boolean }).limited, true)
	assert.equal((await withKey('/people', made.key)).status, 403, 'a reviewer\'s key reads no more than they do')
	assert.equal((await withKey('/keys', made.key, 'POST', { name: 'more' })).status, 403, 'a key makes no keys')
	assert.deepEqual([(await withKey('/me', 'tdr_not-a-key')).status, (await withKey('/me', memberKey)).status], [401, 401], 'a sync key is not a review key')
	assert.equal(await status(`/keys/${made.id}`, neo, 'DELETE'), 404, 'someone else\'s key')
	const neoKey = ((await (await review('/keys', neo, 'POST', { name: 'ci' })).json()) as { key: string }).key
	assert.equal((await withKey('/people', neoKey)).status, 200)
	// A key follows its maker's level.
	assert.equal(await status('/team', superadmin, 'POST', { slack_id: 'UREV', level: 1 }), 200)
	assert.equal((await withKey('/people', made.key)).status, 200)
	assert.equal(await status('/team', superadmin, 'POST', { slack_id: 'UREV', level: 2 }), 200)
	assert.equal((await withKey('/people', made.key)).status, 403)

	// Bans last until lifted, and are only on people below the one who bans.
	const ban = (cookie: string, body: object) => review('/bans', cookie, 'POST', body)
	assert.equal((await ban(rev, { slack_id: 'UPLAIN', reason: 'no' })).status, 403, 'a reviewer bans no one')
	assert.equal((await ban(neo, { slack_id: 'UPLAIN', reason: ' ' })).status, 400, 'a ban needs a reason')
	// A request for a length is refused, so a script can't believe it issued a short ban.
	for (const days of [1, 7, '', null]) {
		const asked = await ban(neo, { slack_id: 'UPLAIN', reason: 'x', days })
		assert.deepEqual([asked.status, /no length/.test(await asked.text())], [400, true], String(days))
	}
	assert.equal((await me(member)).ban, null)
	for (const above of ['UOTHERNEO', 'UNEO', 'UADMIN']) assert.equal((await ban(neo, { slack_id: above, reason: 'x' })).status, 403, above)
	assert.equal((await ban(superadmin, { slack_id: 'UOTHER', reason: 'x' })).status, 403, 'another superadmin')
	const temp = (await (await ban(neo, { slack_id: 'UPLAIN', reason: 'Edited reports' })).json()) as { id: number }
	// Nothing new is taken from them. They are told they are banned until it is lifted, but not why.
	const refused = await call('/api/v1/reports', { method: 'POST', body: laptop(report(6000)), key: memberKey })
	assert.equal(refused.status, 403)
	const said = await refused.text()
	assert.match(said, /banned until a reviewer lifts the ban/)
	assert.doesNotMatch(said, /Edited reports/)
	assert.equal((await call('/api/v1/events', { method: 'POST', body: '', key: memberKey })).status, 403)
	assert.equal((await call('/api/reports', { method: 'POST', body: laptop(report(6000)), cookie: member, origin: SITE })).status, 403)
	// They can still sign in and see what they had.
	const banned = await me(member)
	assert.deepEqual(banned.ban, { until: null })
	const theirs = (await (await call('/api/report', { cookie: member })).json()) as { ban: object; computers: object[] }
	assert.deepEqual([theirs.ban, theirs.computers.length], [{ until: null }, 1])
	assert.equal(((await (await review('/person?slack=UPLAIN', rev)).json()) as typeof seen).ban?.reason, 'Edited reports')
	// Each account view says what the visitor may change of that person: the levels they may give, and whether they may remove, ban, or lift.
	type Access = { level: number | null; levels: number[]; remove: boolean; ban: boolean; lift: boolean }
	const access = async (who: string, cookie: string) => ((await (await review(`/person?slack=${who}`, cookie)).json()) as { access: Access }).access
	assert.deepEqual(await access('UPLAIN', neo), { level: null, levels: [2], remove: false, ban: true, lift: true })
	assert.deepEqual(await access('UPLAIN', superadmin), { level: null, levels: [1, 2], remove: false, ban: true, lift: true })
	assert.deepEqual(await access('UREV', neo), { level: 2, levels: [], remove: true, ban: true, lift: false })
	assert.deepEqual(await access('UREV', superadmin), { level: 2, levels: [1], remove: true, ban: true, lift: false })
	assert.deepEqual(await access('UOTHERNEO', neo), { level: 1, levels: [], remove: false, ban: false, lift: false }, 'a neoadmin, at their own level')
	assert.deepEqual(await access('UADMIN', superadmin), { level: 0, levels: [], remove: false, ban: false, lift: false })
	// A Slack ID that has never signed in opens the same view with its access and bans, so they can be added or banned first.
	const unseen = (await (await review('/person?slack=u0new', neo)).json()) as { signed_in: boolean; person: object; access: Access; bans: object[] }
	assert.deepEqual(unseen, { signed_in: false, person: { slack_id: 'U0NEW' }, access: { level: null, levels: [2], remove: false, ban: true, lift: false }, bans: [] })
	assert.equal(await status('/person?slack=U0NEW', rev), 404, 'a reviewer reads only people who have signed in')
	assert.equal(await status('/person?slack=not-an-id', neo), 400)

	// Lifting it. It holds until then, however long that is.
	const env = await server.getWorker<{ DB: { prepare(sql: string): { run(): Promise<unknown> } } }>().getEnv()
	await env.DB.prepare(`UPDATE bans SET at = ${Date.now() - 400 * DAY} WHERE id = ${temp.id}`).run()
	assert.notEqual((await me(member)).ban, null)
	assert.deepEqual([await status(`/bans/${temp.id}`, rev, 'DELETE'), await status(`/bans/${temp.id}`, neo, 'DELETE'), await status(`/bans/${temp.id}`, neo, 'DELETE')], [403, 200, 404])
	assert.deepEqual([(await me(member)).ban, await sync(6000)], [null, 200])

	// A banned reviewer can't review, and neither can their key. A neoadmin can't undo a superadmin's ban.
	const forever = (await (await ban(superadmin, { slack_id: 'UREV', reason: 'Left the team' })).json()) as { id: number }
	assert.deepEqual(await access('UREV', neo), { level: 2, levels: [], remove: true, ban: false, lift: false }, 'a superadmin\'s ban')
	assert.deepEqual([await status('/me', rev), (await withKey('/me', made.key)).status, (await call('/review/', { cookie: rev })).headers.get('Location')], [403, 403, '/dashboard'])
	assert.deepEqual([await status(`/bans/${forever.id}`, neo, 'DELETE'), (await ban(neo, { slack_id: 'UREV', reason: 'replaced' })).status], [403, 403])
	team = (await (await review('/team', neo)).json()) as Team
	assert.equal(team.reviewers.find((r) => r.slack_id === 'UREV')!.banned, 1)
	assert.equal(await status(`/bans/${forever.id}`, superadmin, 'DELETE'), 200)
	assert.equal(await status('/me', rev), 200)

	// Removing a reviewer ends their keys too. Every change is on record.
	assert.equal(await status('/team/UREV', neo, 'DELETE'), 200)
	assert.deepEqual([await status('/me', rev), (await withKey('/me', made.key)).status], [403, 401])
	team = (await (await review('/team', superadmin)).json()) as Team
	for (const [action, slack, by] of [['add', 'UNEO', 'UADMIN'], ['change', 'UREV', 'UADMIN'], ['ban', 'UPLAIN', 'UNEO'], ['unban', 'UREV', 'UADMIN'], ['remove', 'UREV', 'UNEO']]) {
		assert.ok(team.log.some((l) => l.action === action && l.slack_id === slack && l.by_slack_id === by), `${action} ${slack} by ${by}`)
	}
})

test('migration 0012 makes timed bans in force permanent and leaves ones that ran out over', () => {
	const db = new DatabaseSync(':memory:')
	const migrations = new URL('../migrations/', import.meta.url)
	for (const file of readdirSync(migrations).sort().filter((f) => f < '0012')) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
	const now = Date.now()
	const add = db.prepare('INSERT INTO bans (slack_id, reason, by_slack_id, by_level, at, until, lifted_at, lifted_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
	add.run('URANOUT', 'ran out', 'UNEO', now - 9 * DAY, now - 2 * DAY, null, null)
	add.run('UTIMED', 'timed', 'UNEO', now - DAY, now + 6 * DAY, null, null)
	add.run('ULIFTED', 'lifted', 'UNEO', now - 3 * DAY, now + 4 * DAY, now - DAY, 'UNEO')
	add.run('UFOREVER', 'forever', 'UNEO', now - DAY, null, null, null)
	db.exec(readFileSync(new URL('0012_permanent_bans.sql', migrations), 'utf8'))
	const rows = Object.fromEntries((db.prepare('SELECT slack_id, until, was_until, lifted_at, lifted_by FROM bans').all() as { slack_id: string }[]).map(({ slack_id, ...b }) => [slack_id, b]))
	assert.deepEqual(rows, {
		URANOUT: { until: now - 2 * DAY, was_until: now - 2 * DAY, lifted_at: now - 2 * DAY, lifted_by: null },
		UTIMED: { until: null, was_until: now + 6 * DAY, lifted_at: null, lifted_by: null },
		ULIFTED: { until: now + 4 * DAY, was_until: now + 4 * DAY, lifted_at: now - DAY, lifted_by: 'UNEO' },
		UFOREVER: { until: null, was_until: null, lifted_at: null, lifted_by: null },
	})
	const noted = db.prepare('SELECT by_slack_id, action, slack_id, detail FROM staff_log').all() as { slack_id: string; action: string; detail: string }[]
	assert.deepEqual(noted.map((l) => [l.slack_id, l.action]), [['UTIMED', 'permanent']])
	assert.equal(noted[0]!.detail, `was to end ${new Date(now + 6 * DAY).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
})

test('anyone reads their own stats through the public API with a read key, unless banned', async () => {
	const cookie = await signIn('reader')
	const { api_key: syncKey, slack_id } = await me(cookie)
	const keys = (method: string, path = '', body?: object) => call(`/api/keys${path}`, { method, cookie, origin: method === 'GET' ? undefined : SITE, body: body && JSON.stringify(body) })
	const read = (path: string, key: string) => call(`/api/public/v1${path}`, { key })

	// A read key is made while signed in, shown once, and listed by its start only.
	assert.equal((await call('/api/keys', { method: 'POST', cookie, body: '{"name":"x"}' })).status, 403, 'no Origin')
	assert.equal((await keys('POST', '', { name: ' ' })).status, 400)
	const made = (await (await keys('POST', '', { name: 'portfolio' })).json()) as { id: number; key: string }
	assert.match(made.key, /^tdp_/)
	const listed = (await (await keys('GET')).json()) as { keys: { name: string; hint: string }[] }
	assert.deepEqual(listed.keys.map((k) => [k.name, made.key.startsWith(k.hint)]), [['portfolio', true]])
	assert.doesNotMatch(JSON.stringify(listed), new RegExp(made.key))

	// Projects come with their repository. A folder on the computer, or a repository on a machine at home, stays private.
	const now = Date.now()
	const laptop = computer()
	const body = laptop({
		engaged_seconds: 5400,
		blocks: [{ ...block(now - 60_000, 'site'), project: { key: 'github.com/kid/site', name: 'site' } }, { ...block(now - 5000, 'game'), project: { key: '/home/kid/game', name: 'game' } }],
		projects: [{ project: { key: 'github.com/kid/site', name: 'site' }, engaged_seconds: 3600 }, { project: { key: '/home/kid/game', name: 'game' }, engaged_seconds: 1800 }, { project: { key: 'nas.local/volume1/homes/kid/app', name: 'app' }, engaged_seconds: 60 }],
		days: [{ date: '2026-01-02', engaged_seconds: 5400 }],
	})
	assert.equal((await call('/api/v1/reports', { method: 'POST', body, key: syncKey })).status, 200)
	const projects = (await (await read('/projects', made.key)).json()) as { projects: { name: string; repo: string | null; engaged_seconds: number; last_active: number }[] }
	assert.deepEqual(projects.projects.map((p) => [p.name, p.repo, p.engaged_seconds]), [['site', 'github.com/kid/site', 3600], ['game', null, 1800], ['app', null, 60]])
	assert.equal(projects.projects[0]!.last_active, now - 60_000)
	assert.doesNotMatch(JSON.stringify(projects), /home\/kid|homes|nas\.local|td-[0-9a-f]/)
	const mine = (await (await read('/me', made.key)).json()) as { slack_id: string; engaged_seconds: number }
	assert.deepEqual([mine.slack_id, mine.engaged_seconds], [slack_id, 5400])
	assert.deepEqual(await (await read('/days?since=2026-01-02', made.key)).json(), { days: [{ date: '2026-01-02', engaged_seconds: 5400 }] })
	assert.deepEqual(await (await read('/days?since=2026-01-03', made.key)).json(), { days: [] })

	// Another site may call it from the browser. Only a read key reads: not the sync key, not a session.
	const preflight = await call('/api/public/v1/projects', { method: 'OPTIONS', origin: 'https://portfolio.example' })
	assert.deepEqual([preflight.status, preflight.headers.get('Access-Control-Allow-Origin'), preflight.headers.get('Access-Control-Allow-Headers')], [204, '*', 'Authorization, Content-Type'])
	const refused = await read('/me', syncKey)
	assert.deepEqual([refused.status, refused.headers.get('Access-Control-Allow-Origin')], [401, '*'])
	assert.equal((await call('/api/public/v1/me', { cookie })).status, 401)
	assert.equal((await call('/api/v1/reports', { method: 'POST', body, key: made.key })).status, 401, 'a read key uploads nothing')

	// A banned person's keys read nothing, and work again once the ban is lifted.
	const admin = await signIn('admin')
	const banned = (await (await call('/api/review/bans', { method: 'POST', cookie: admin, origin: SITE, body: JSON.stringify({ slack_id, reason: 'Faked hours' }) })).json()) as { id: number }
	const denied = await read('/projects', made.key)
	assert.equal(denied.status, 403)
	assert.doesNotMatch(await denied.text(), /Faked hours/)
	assert.equal((await call(`/api/review/bans/${banned.id}`, { method: 'DELETE', cookie: admin, origin: SITE })).status, 200)
	assert.equal((await read('/me', made.key)).status, 200)

	// Revoking is at once, and only by the owner.
	assert.equal((await call(`/api/keys/${made.id}`, { method: 'DELETE', cookie: admin, origin: SITE })).status, 404)
	assert.equal((await keys('DELETE', `/${made.id}`)).status, 200)
	assert.equal((await read('/me', made.key)).status, 401)
})

test('every profile is public by default, and shows no name, Slack ID, or folder', async () => {
	const cookie = await signIn('kid')
	const { api_key: key, handle, profile_public } = await me(cookie)
	assert.match(handle, /^u-[0-9a-f]{12}$/, 'a neutral handle, not one made from the name')
	assert.equal(profile_public, true)
	const settings = (body: object) => call('/api/profile', { method: 'POST', cookie, origin: SITE, body: JSON.stringify(body) })
	const profile = (h: string) => call(`/api/public/v1/users/${h}`)
	const named = async (h: string) => {
		const p = (await (await profile(h)).json()) as { projects: { name: string; repo: string | null }[]; other_projects: { count: number; engaged_seconds: number } }
		return { names: p.projects.map((x) => [x.name, x.repo]), other: p.other_projects }
	}

	const now = Date.now()
	const site = { key: 'github.com/kid/site', name: 'site' }, game = { key: '/home/kid/game', name: 'game' }
	const body = computer()({
		engaged_seconds: 5000,
		blocks: [{ ...block(now - 60_000), project: site }, { ...block(now - 5000), project: game }],
		projects: [{ project: site, engaged_seconds: 3600 }, { project: game, engaged_seconds: 1800 }],
		days: [{ date: '2026-01-02', engaged_seconds: 5000 }],
	})
	assert.equal((await call('/api/v1/reports', { method: 'POST', body, key })).status, 200)

	// Anyone reads it with no credentials. The repository is named; the folder is only counted.
	const res = await profile(handle)
	assert.deepEqual([res.status, res.headers.get('Access-Control-Allow-Origin'), res.headers.get('Cache-Control')], [200, '*', 'public, max-age=60'])
	const text = await res.text()
	const p = JSON.parse(text) as { handle: string; engaged_seconds: number; days: unknown[]; projects: unknown[]; other_projects: unknown }
	assert.deepEqual([p.handle, p.engaged_seconds, p.days], [handle, 5000, [{ date: '2026-01-02', engaged_seconds: 5000 }]])
	assert.deepEqual(p.projects, [{ name: 'site', repo: 'github.com/kid/site', engaged_seconds: 3600 }])
	assert.deepEqual(p.other_projects, { count: 1, engaged_seconds: 1800 })
	assert.doesNotMatch(text, /kid<|&lt;b|UKID|home\/kid|game|td-[0-9a-f]|tdk_/)
	const page = await call(`/@${handle}`)
	assert.equal(page.status, 200)
	assert.match(await page.text(), /profile\.js/)
	assert.equal((await call('/@u-000000000000')).status, 404)
	assert.equal((await profile('u-000000000000')).status, 404)

	// The owner names or hides each project, but only their own.
	assert.equal((await settings({ projects: { '/home/kid/game': true, 'github.com/kid/site': false } })).status, 200)
	assert.deepEqual(await named(handle), { names: [['game', null]], other: { count: 1, engaged_seconds: 3600 } })
	assert.equal((await settings({ projects: { '/home/other/thing': true } })).status, 404)
	assert.equal((await settings({ projects: { 'github.com/kid/site': 'yes' } })).status, 400)

	// A new handle moves the profile. Handles are lowercase, and two people can't share one.
	assert.equal((await settings({ handle: 'a' })).status, 400)
	assert.equal((await settings({ handle: '-kid' })).status, 400)
	assert.equal((await call('/api/profile', { method: 'POST', cookie, body: '{"handle":"kid-codes"}' })).status, 403, 'no Origin')
	const moved = (await (await settings({ handle: 'Kid-Codes' })).json()) as { handle: string }
	assert.equal(moved.handle, 'kid-codes')
	assert.equal((await profile(handle)).status, 404)
	assert.equal((await profile('KID-CODES')).status, 200)
	const other = await signIn('kid2')
	assert.equal((await call('/api/profile', { method: 'POST', cookie: other, origin: SITE, body: '{"handle":"kid-codes"}' })).status, 409)

	// A private profile, a ban, and a deleted account each look like no profile at all.
	assert.equal((await settings({ public: false })).status, 200)
	assert.deepEqual([(await profile('kid-codes')).status, (await call('/@kid-codes')).status], [404, 404])
	assert.equal((await settings({ public: true })).status, 200)
	const admin = await signIn('admin')
	const ban = (await (await call('/api/review/bans', { method: 'POST', cookie: admin, origin: SITE, body: JSON.stringify({ slack_id: 'UKID', reason: 'Faked hours' }) })).json()) as { id: number }
	assert.equal((await profile('kid-codes')).status, 404)
	assert.equal((await call(`/api/review/bans/${ban.id}`, { method: 'DELETE', cookie: admin, origin: SITE })).status, 200)
	assert.equal((await profile('kid-codes')).status, 200)
	assert.equal((await call('/api/account', { method: 'DELETE', cookie, origin: SITE })).status, 200)
	assert.equal((await profile('kid-codes')).status, 404)
	// The handle is free again, and signing in again reopens the account with a new neutral one.
	assert.equal((await call('/api/profile', { method: 'POST', cookie: other, origin: SITE, body: '{"handle":"kid-codes"}' })).status, 200)
	assert.match((await me(await signIn('kid'))).handle, /^u-[0-9a-f]{12}$/)
})

test('another site gets a read key when a person signs in there with teardrop', async () => {
	const back = 'https://portfolio.example/done?from=td'
	const ask = (extra = '') => `/authorize?redirect_uri=${encodeURIComponent(back)}&state=s%7C1&name=${encodeURIComponent('<b>Folio</b>')}${extra}`
	const allow = (cookie: string, decision: string, fields: Record<string, string> = {}, origin = SITE) =>
		server.fetch(SITE + '/authorize', {
			method: 'POST',
			redirect: 'manual',
			headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ redirect_uri: back, state: 's|1', name: 'Folio', decision, ...fields }).toString(),
		})
	const trade = (fields: Record<string, string>) => call('/api/public/v1/token', { method: 'POST', body: JSON.stringify(fields), origin: 'https://portfolio.example' })

	// Signed out, they sign in first and come back to the same request.
	const out = await call(ask())
	assert.equal(out.status, 302)
	assert.equal(new URL(out.headers.get('Location')!, SITE).searchParams.get('next'), `/authorize?redirect_uri=${encodeURIComponent(back).replace(/%20/g, '+')}&state=s%7C1&name=%3Cb%3EFolio%3C%2Fb%3E`)

	// Only addresses on https, or on this computer, are sent back to.
	const cookie = await signIn('folio')
	for (const bad of ['http://portfolio.example/x', 'javascript:alert(1)', 'https://u:p@portfolio.example/', 'https://portfolio.example/#x', '']) {
		const res = await call(`/authorize?redirect_uri=${encodeURIComponent(bad)}`, { cookie })
		assert.equal(res.status, 400, bad)
		assert.equal(res.headers.get('Location'), null)
	}
	assert.equal((await call(`/authorize?redirect_uri=${encodeURIComponent('http://localhost:3000/cb')}`, { cookie })).status, 200)

	// The page names the site by its address as well as the name it gives, escaped.
	const page = await (await call(ask(), { cookie })).text()
	assert.match(page, /https:\/\/portfolio\.example/)
	assert.match(page, /&#60;b&#62;Folio/)
	assert.doesNotMatch(page, /<b>Folio/)

	// Allowing takes a request from this site. Cancelling sends them back with nothing.
	assert.equal((await allow(cookie, 'allow', {}, 'https://portfolio.example')).status, 403)
	const denied = new URL((await allow(cookie, 'deny')).headers.get('Location')!)
	assert.deepEqual([denied.origin + denied.pathname, denied.searchParams.get('error'), denied.searchParams.get('state'), denied.searchParams.get('code')], ['https://portfolio.example/done', 'access_denied', 's|1', null])
	const allowed = new URL((await allow(cookie, 'allow')).headers.get('Location')!)
	assert.deepEqual([allowed.searchParams.get('from'), allowed.searchParams.get('state')], ['td', 's|1'])
	const code = allowed.searchParams.get('code')!

	// The code becomes a read key once, for the address it was made for.
	assert.equal((await trade({ code, redirect_uri: 'https://portfolio.example/other' })).status, 400)
	const traded = await trade({ code, redirect_uri: back })
	assert.equal(traded.headers.get('Access-Control-Allow-Origin'), '*')
	const got = (await traded.json()) as { key: string; slack_id: string }
	assert.deepEqual([got.key.startsWith('tdp_'), got.slack_id], [true, 'UFOLIO'])
	assert.equal((await call('/api/public/v1/me', { key: got.key })).status, 200)
	const listed = (await (await call('/api/keys', { cookie })).json()) as { keys: { name: string; site: string }[] }
	assert.deepEqual(listed.keys.map((k) => [k.name, k.site]), [['Folio', 'https://portfolio.example']])
	// Used again, the code fails and the key it became stops working, since someone else may have it.
	assert.equal((await trade({ code, redirect_uri: back })).status, 400)
	assert.equal((await call('/api/public/v1/me', { key: got.key })).status, 401)

	// With PKCE, only the verifier behind the challenge trades the code.
	const verifier = 'a-verifier-that-is-long-enough-to-count-0123456789'
	const challenge = createHash('sha256').update(verifier).digest('base64url')
	assert.equal((await call(ask('&code_challenge=short'), { cookie })).status, 400)
	const pkce = new URL((await allow(cookie, 'allow', { code_challenge: challenge })).headers.get('Location')!).searchParams.get('code')!
	assert.equal((await trade({ code: pkce, redirect_uri: back })).status, 400)
	assert.equal((await trade({ code: pkce, redirect_uri: back, code_verifier: 'wrong' })).status, 400)
	assert.equal((await trade({ code: pkce, redirect_uri: back, code_verifier: verifier })).status, 200)
	assert.equal((await trade({ code: 'tdc_nope', redirect_uri: back })).status, 400)

	// A banned person can't allow a site, and isn't told why.
	const admin = await signIn('admin')
	const ban = await call('/api/review/bans', { method: 'POST', cookie: admin, origin: SITE, body: JSON.stringify({ slack_id: 'UFOLIO', reason: 'Faked hours' }) })
	assert.equal(ban.status, 200)
	const bannedPage = await call(ask(), { cookie })
	assert.equal(bannedPage.status, 403)
	assert.doesNotMatch(await bannedPage.text(), /Faked hours/)
	assert.equal((await allow(cookie, 'allow')).status, 403)
})

test('a submission credits only witnessed time, and only once', async () => {
	const cookie = await signIn('submitter')
	const { api_key: key } = await me(cookie)
	const now = Date.now()
	const line = (t: number, event: string, extra: object = {}) => JSON.stringify({ t: new Date(t).toISOString(), tool: 'claude-code', event, session: 'p1', project: 'github.com/kid/game', ...extra })
	const post = (lines: string[]) => call('/api/v1/events', { method: 'POST', key, body: lines.join('\n') })
	const submitIt = (as = key) => call('/api/v1/submissions', { method: 'POST', key: as, body: JSON.stringify({ project: 'github.com/kid/game' }) })
	// Witnessed, sent within 5 minutes: 2 minutes watching, 2 writing. Backdated by 3 hours: 2 and 2, not credited.
	await post([line(now - 290_000, 'UserPromptSubmit', { human: true, judged: 6, real: 6 }), line(now - 170_000, 'Stop'), line(now - 50_000, 'UserPromptSubmit', { human: true, judged: 5, real: 5 })])
	const old = now - 3 * 3600_000
	await post([line(old, 'UserPromptSubmit', { human: true, session: 'p0' }), line(old + 120_000, 'Stop', { session: 'p0' }), line(old + 240_000, 'UserPromptSubmit', { human: true, session: 'p0' })])
	assert.equal((await call('/api/v1/submissions', { method: 'POST', body: '{}' })).status, 401)
	const oldClient = await call('/api/v1/submissions', { method: 'POST', key, body: JSON.stringify({ signed: { v: 1 }, logs: ['x'] }) })
	assert.equal(oldClient.status, 400)
	assert.match(await oldClient.text(), /teardrop update/)
	const first = (await (await submitIt()).json()) as { id: string; witnessed_seconds: number; unwitnessed_seconds: number; credited_seconds: number; prompts: number }
	assert.deepEqual([first.witnessed_seconds, first.unwitnessed_seconds, first.credited_seconds, first.prompts], [240, 240, 240, 4])
	// A second submission credits only what is new: 30 more witnessed seconds.
	await post([line(now - 20_000, 'Stop', { session: 'p1' })])
	const second = (await (await submitIt()).json()) as { credited_seconds: number; earlier_overlap_seconds: number }
	assert.deepEqual([second.credited_seconds, second.earlier_overlap_seconds], [30, 240])

	// Review: every level reads it; a reviewer sees no project key and no computer IDs.
	const admin = await signIn('admin')
	const page = (await (await call(`/api/review/submissions/${first.id}`, { cookie: admin })).json()) as { records: { computer: string; late_ms: number }[]; flags: unknown[] }
	assert.equal(page.records.length, 7)
	assert.ok(page.records.some((r) => r.late_ms > 3600_000), 'how late each record arrived is shown')
	assert.deepEqual(page.flags, [])
	// Accepting unwitnessed time: a neoadmin or superadmin, with a note, capped at what is unwitnessed.
	const accept = (as: string, body: object) => call(`/api/review/submissions/${first.id}/accept`, { method: 'POST', cookie: as, origin: SITE, body: JSON.stringify(body) })
	assert.equal((await accept(admin, { seconds: 999 })).status, 400)
	assert.equal((await accept(admin, { seconds: 999, note: 'Offline on a train; commits match.' })).status, 200)
	const list = (await (await call('/api/review/submissions', { cookie: admin })).json()) as { submissions: { id: string; accepted_seconds: number; project_key?: string }[] }
	assert.equal(list.submissions.find((s) => s.id === first.id)!.accepted_seconds, 240)
	const env = await server.getWorker<{ DB: { prepare(sql: string): { first<T>(): Promise<T | null> } } }>().getEnv()
	assert.ok(await env.DB.prepare(`SELECT 1 FROM staff_log WHERE action = 'accept'`).first())

	// A banned account can't submit.
	assert.equal((await call('/api/review/bans', { method: 'POST', cookie: admin, origin: SITE, body: JSON.stringify({ slack_id: 'USUBMITTER', reason: 'test' }) })).status, 200)
	assert.equal((await submitIt()).status, 403)
})

test('the site keeps every prompt record in R2 and credits only time it saw arrive', async () => {
	const cookie = await signIn('recorder')
	const { api_key: key } = await me(cookie)
	const now = Date.now()
	const at = (ms: number) => new Date(ms).toISOString()
	const line = (t: number, event: string, extra: object = {}) => JSON.stringify({ t: at(t), tool: 'cursor', event, session: 's1', project: 'github.com/kid/site', ...extra })
	const post = (lines: string[]) => call('/api/v1/events', { method: 'POST', key, body: lines.join('\n') })
	// Live: a prompt, the agent's reply 160 seconds later, and the next prompt two minutes after that.
	const live = [line(now - 280_000, 'prompt', { human: true, sim: '18446744073709551615', judged: 6, real: 6 }), line(now - 120_000, 'turn_end', { in: 900, out: 40 }), line(now - 1000, 'prompt', { human: true, judged: 4, real: 4 })]
	let res = await post(live)
	assert.deepEqual([res.status, await res.json()], [200, { stored: 0, records: 3 }])
	assert.deepEqual(await (await post(live)).json(), { stored: 0, records: 0 }, 'a record sent twice is kept once')
	// Backdated: a session from three hours ago, sent now, is kept but not witnessed.
	const old = now - 3 * 3600_000
	await post([line(old, 'prompt', { human: true, session: 's2' }), line(old + 120_000, 'turn_end', { session: 's2' }), line(old + 240_000, 'prompt', { human: true, session: 's2' })])
	// From a clock 10 minutes fast: refused, and the reply says so, so the CLI can warn.
	res = await post([line(now + 600_000, 'prompt', { human: true, session: 'fast' }), line(now + 60_000, 'turn_end', { session: 'fast' })])
	assert.deepEqual([res.status, await res.json()], [200, { stored: 0, records: 1, dropped_future: 1 }])
	assert.equal((await call('/api/v1/events', { method: 'POST', body: live[0] })).status, 401)
	// whoami names the key's owner and gives the site's clock.
	const who = (await (await call('/api/v1/whoami', { key })).json()) as { name: string; handle: string; time: string }
	assert.equal(who.name, '<b>recorder</b>')
	assert.ok(Math.abs(Date.parse(who.time) - Date.now()) < 60_000, `whoami time ${who.time}`)
	assert.equal((await call('/api/v1/whoami')).status, 401)

	const worker = server.getWorker<{
		HUB: { idFromName(name: string): unknown; get(id: unknown): unknown }
		DB: { prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null>; all(): Promise<{ results: unknown[] }> } } }
		REPORTS: { get(key: string): Promise<{ body: ReadableStream } | null> }
	}>()
	const env = await worker.getEnv()
	const id = (await env.DB.prepare('SELECT id FROM users WHERE slack_id = ?').bind('URECORDER').first<{ id: number }>())!.id
	const hub = env.HUB.get(env.HUB.idFromName(String(id))) as unknown as { flush(): Promise<string[]> }
	const days = await hub.flush()
	assert.ok(days.length >= 1)
	const rows = (await env.DB.prepare(`SELECT day, witnessed_seconds, unwitnessed_seconds, prompts, tokens_in FROM prompt_days WHERE user_id = ? AND computer_id = '' ORDER BY day`).bind(id).all()).results as { witnessed_seconds: number; unwitnessed_seconds: number; prompts: number; tokens_in: number }[]
	const sum = (k: 'witnessed_seconds' | 'unwitnessed_seconds' | 'prompts' | 'tokens_in') => rows.reduce((n, r) => n + r[k], 0)
	// Live: 160s watching the agent, then 119s writing the next prompt. Backdated: 120s + 120s.
	assert.deepEqual([sum('witnessed_seconds'), sum('unwitnessed_seconds'), sum('prompts'), sum('tokens_in')], [279, 240, 4, 900])
	// The backdated records can fall on the day before the live ones, so read every day's file.
	let text = ''
	for (const day of days) {
		const obj = await env.REPORTS.get(`${id}/prompts/${day.slice(0, 4)}/${day.slice(5)}.ndjson.gz`)
		text += await new Response(obj!.body.pipeThrough(new DecompressionStream('gzip'))).text()
	}
	assert.match(text, /"sim":"18446744073709551615"/, 'the fingerprint is never rounded')
	assert.doesNotMatch(text, /prompt text/)
})

test('home and docs work for anyone, and show the account menu once signed in', async () => {
	for (const page of ['/', '/docs']) {
		const plain = await call(page)
		assert.equal(plain.status, 200, page)
		assert.doesNotMatch(await plain.text(), /<html[^>]* data-hosted/)
		const cookie = await signIn('menu')
		const signedIn = await (await call(page, { cookie })).text()
		assert.match(signedIn, /<html[^>]* data-hosted/, page)
		assert.match(signedIn, /id="account-name-full"[^>]*>&lt;b&gt;menu&lt;\/b&gt;</, page)
	}
	// Home stays up before the secrets exist.
	const bare = createTestHarness({ workers: [{ configPath: new URL('../wrangler.jsonc', import.meta.url), vars: { DEV_LOGIN: '' }, secrets: { SESSION_SECRET: '' } }] })
	try {
		await bare.listen()
		assert.equal((await bare.fetch(SITE + '/')).status, 200)
		assert.equal((await bare.fetch(SITE + '/', { headers: { Cookie: 'teardrop_session=junk.junk' } })).status, 200)
	} finally {
		await bare.close()
	}
})

test('exporting and deleting your own data', async () => {
	const cookie = await signIn('leaver')
	const { api_key: key } = await me(cookie)
	const now = Date.now()
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: computer()({ engaged_seconds: 600, blocks: [block(now - 1000)] }), key })).status, 200)

	const out = await call('/api/export', { cookie })
	assert.match(out.headers.get('Content-Disposition')!, /attachment/)
	const data = (await out.json()) as { profile: { name: string; slack_id: string }; computers: unknown[] }
	assert.deepEqual([data.profile.slack_id, data.computers.length], ['ULEAVER', 1])
	assert.doesNotMatch(JSON.stringify(data), /tdk_/, 'the sync key stays out of the export')
	assert.equal((await call('/api/export')).status, 401)

	assert.equal((await call('/api/account', { method: 'DELETE', cookie })).status, 403, 'no Origin')
	const gone = await call('/api/account', { method: 'DELETE', cookie, origin: SITE })
	assert.equal(gone.status, 200)
	assert.equal(cookies(gone), 'teardrop_session=')
	// The old session and sync key are dead, and the computer is free to join someone else.
	assert.equal((await call('/api/me', { cookie })).status, 401)
	assert.equal((await call('/api/v1/reports', { method: 'POST', body: '{}', key })).status, 401)
	const env = await server.getWorker<{ DB: { prepare(sql: string): { first(): Promise<{ n: number }> } } }>().getEnv()
	assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM computers WHERE user_id NOT IN (SELECT id FROM users)").first()).n, 0)
	assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM report_chunks WHERE computer_id NOT IN (SELECT id FROM computers)').first()).n, 0)
})

test('a dashboard hears of each record at once, and a profile never learns the project', async () => {
	const cookie = await signIn('livewire')
	const { api_key: key, handle } = await me(cookie)
	const other = await signIn('bystander')
	const line = (t: number, event: string, extra: object = {}) => JSON.stringify({ t: new Date(t).toISOString(), tool: 'codex', event, session: 'l1', project: 'github.com/kid/secret', ...extra })
	const open = async (path: string, as = '') => {
		const res = await server.fetch(SITE + path, { headers: { Upgrade: 'websocket', Origin: SITE, Cookie: as } })
		assert.equal(res.status, 101, path)
		const ws = (res as unknown as { webSocket: WebSocket & { accept(): void } }).webSocket
		ws.accept()
		const got: { working: { tool: string; project?: string; since: number } | null; today: { prompts: number } }[] = []
		ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data))))
		return { ws, got }
	}
	const mine = await open('/api/live/ws', cookie)
	const theirs = await open('/api/live/ws', other)
	const visitor = await open(`/api/public/v1/users/${handle}/live`)
	await new Promise((r) => setTimeout(r, 200))
	const before = [mine.got.length, theirs.got.length, visitor.got.length]
	assert.equal((await call('/api/v1/events', { method: 'POST', key, body: line(Date.now() - 1000, 'prompt', { human: true, judged: 5, real: 5 }) })).status, 200)
	await new Promise((r) => setTimeout(r, 300))
	assert.equal(mine.got.length, before[0]! + 1, 'the owner heard of the prompt')
	assert.equal(theirs.got.length, before[1], "another person's socket heard nothing")
	assert.deepEqual([mine.got.at(-1)!.working, mine.got.at(-1)!.today.prompts], [{ tool: 'codex', project: 'github.com/kid/secret', since: mine.got.at(-1)!.working!.since, kind: 'prompt' }, 1])
	assert.equal(visitor.got.at(-1)!.working!.tool, 'codex')
	assert.doesNotMatch(JSON.stringify(visitor.got), /secret/, 'a profile socket never carries the project')
	// Without a socket, the same state once, for the first paint and the 30-second fallback.
	const state = (await (await call('/api/live', { cookie })).json()) as { working: { project: string } }
	assert.equal(state.working.project, 'github.com/kid/secret')
	assert.equal((await call('/api/live/ws', { cookie, origin: SITE })).status, 426)
	assert.equal((await server.fetch(SITE + '/api/live/ws', { headers: { Upgrade: 'websocket', Origin: 'https://evil.example', Cookie: cookie } })).status, 403)
	for (const s of [mine, theirs, visitor]) s.ws.close()
})

test('commits travel as records, earn no time, and are checked against GitHub', async () => {
	const cookie = await signIn('committer')
	const { api_key: key } = await me(cookie)
	const now = Date.now()
	const rec = (project: string, sha: string, t: number) => JSON.stringify({ t: new Date(t).toISOString(), tool: 'git', event: 'commit', session: sha, git: project, sha, added: 12, removed: 3 })
	const body = [rec('github.com/kid/site', 'a'.repeat(40), now - 60_000), rec('github.com/kid/site', 'b'.repeat(40), now - 30_000), rec('github.com/kid/secret', 'c'.repeat(40), now - 20_000), rec('github.com/kid/site', 'not-a-sha', now)]
	assert.deepEqual(await (await call('/api/v1/events', { method: 'POST', key, body: body.join('\n') })).json(), { stored: 0, records: 3 })
	const env = await server.getWorker<{
		HUB: { idFromName(name: string): unknown; get(id: unknown): unknown }
		DB: { prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null>; all(): Promise<{ results: unknown[] }> } } }
	}>().getEnv()
	const id = (await env.DB.prepare('SELECT id FROM users WHERE slack_id = ?').bind('UCOMMITTER').first<{ id: number }>())!.id
	await (env.HUB.get(env.HUB.idFromName(String(id))) as unknown as { flush(): Promise<string[]> }).flush()
	const day = await env.DB.prepare(`SELECT witnessed_seconds + unwitnessed_seconds AS s, prompts FROM prompt_days WHERE user_id = ? AND computer_id = ''`).bind(id).first<{ s: number; prompts: number }>()
	assert.deepEqual(day, { s: 0, prompts: 0 }, 'commits earn no time')

	const { checkGit } = await import('../src/git.ts')
	const github = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
	assert.equal(await checkGit({ DB: env.DB, GITHUB_API: github } as never), 0, 'without a token the check is off')
	assert.ok((await checkGit({ DB: env.DB, GITHUB_TOKEN: 't', GITHUB_API: github } as never)) >= 2)
	const rows = (await env.DB.prepare('SELECT project_key, claimed, found, recent FROM project_git WHERE user_id = ? ORDER BY project_key').bind(id).all()).results as { project_key: string; claimed: number; found: number; recent: string }[]
	const found = (r: { recent: string }) => (JSON.parse(r.recent) as { sha: string; found?: boolean }[]).map((c) => [c.sha[0], c.found ?? null])
	assert.deepEqual(rows.map((r) => [r.project_key, r.claimed, r.found, found(r)]), [
		['github.com/kid/secret', 1, 0, [['c', null]]], // private: not checked, never "not found"
		['github.com/kid/site', 2, 1, [['b', false], ['a', true]]],
	])
})

test('a superadmin imports what the old review server credited, and it is never credited again', async () => {
	const cookie = await signIn('importer')
	const { api_key: key } = await me(cookie)
	const sync = computer()
	assert.equal((await call('/api/v1/reports', { method: 'POST', key, body: sync({ blocks: [], projects: [], engaged_seconds: 0 }) })).status, 200)
	const { computers: mine } = (await (await call('/api/me', { cookie })).json()) as { computers: { id: string }[] }
	const now = Date.now()
	const iso = (t: number) => new Date(t).toISOString()
	const lines = [
		{ id: 'r1', account: mine[0]!.id, project: { key: 'github.com/kid/old', name: 'old' }, received_at: iso(now - 86400_000), engaged: [{ start: iso(now - 600_000), end: iso(now - 280_000) }], credited_seconds: 320 },
		{ id: 'r2', account: 'td-ffffffffffff', project: { key: 'x', name: 'x' }, received_at: iso(now), credited_seconds: 5 },
	].map((r) => JSON.stringify(r)).join('\n')
	const reviewer = await signIn('admin')
	const importIt = () => call('/api/review/import', { method: 'POST', cookie: reviewer, origin: SITE, body: lines })
	assert.deepEqual(await (await importIt()).json(), { imported: 1, unknown: ['r2'] })
	assert.deepEqual(await (await importIt()).json(), { imported: 0, unknown: ['r2'] }, 'importing twice adds nothing')
	// Live records over the same stretch earn nothing new.
	const line = (t: number, event: string, extra: object = {}) => JSON.stringify({ t: iso(t), tool: 'claude-code', event, session: 'o', project: 'github.com/kid/old', ...extra })
	await call('/api/v1/events', { method: 'POST', key, body: [line(now - 290_000, 'UserPromptSubmit', { human: true }), line(now - 170_000, 'Stop')].join('\n') })
	const sub = (await (await call('/api/v1/submissions', { method: 'POST', key, body: JSON.stringify({ project: 'github.com/kid/old' }) })).json()) as { credited_seconds: number; earlier_overlap_seconds: number }
	assert.deepEqual([sub.credited_seconds, sub.earlier_overlap_seconds], [110, 10])
})

test('a computer that sends only records shows on the dashboard, and usage earns no time', async () => {
	const cookie = await signIn('recordsonly')
	const { api_key: key } = await me(cookie)
	const now = Date.now()
	const pc = 'td-00aa11bb22cc'
	const line = (t: number, event: string, extra: object = {}) => JSON.stringify({ t: new Date(t).toISOString(), tool: 'claude-code', event, session: 'r1', git: 'github.com/kid/rec', ...extra })
	const post = (lines: string[]) => server.fetch(SITE + '/api/v1/events', { method: 'POST', body: lines.join('\n'), headers: { Authorization: `Bearer ${key}`, 'X-Teardrop-Computer': pc, 'X-Teardrop-UTC-Offset': '0' } })
	await post([line(now - 290_000, 'UserPromptSubmit', { human: true, judged: 6, real: 6 }), line(now - 170_000, 'Stop'), line(now - 290_000, 'usage', { in: 500, out: 20 })])
	// The usage of a growing turn is sent again; the latest replaces it.
	await post([line(now - 290_000, 'usage', { in: 900, out: 40 })])
	const env = await server.getWorker<{ HUB: { idFromName(name: string): unknown; get(id: unknown): unknown }; DB: { prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } } } }>().getEnv()
	const id = (await env.DB.prepare('SELECT id FROM users WHERE slack_id = ?').bind('URECORDSONLY').first<{ id: number }>())!.id
	await (env.HUB.get(env.HUB.idFromName(String(id))) as unknown as { flush(): Promise<string[]> }).flush()
	const day = await env.DB.prepare(`SELECT witnessed_seconds AS w, prompts, tokens_in FROM prompt_days WHERE user_id = ? AND computer_id = ''`).bind(id).first()
	assert.deepEqual(day, { w: 120, prompts: 1, tokens_in: 900 })
	const [c] = (await reports(cookie)) as unknown as { id: string; report: { since: string; report: { engaged_seconds: number; blocks: { project: { key: string }; prompts: number; tokens_in: number; tools: string[] }[] } } }[]
	assert.equal(c!.id, pc)
	assert.equal(c!.report.since, 'records')
	assert.equal(c!.report.report.engaged_seconds, 120)
	assert.deepEqual(c!.report.report.blocks.map((b) => [b.project.key, b.prompts, b.tokens_in, b.tools]), [['github.com/kid/rec', 1, 900, ['claude-code']]])
	assert.deepEqual((await me(cookie)).computers.map((x) => x.id), [pc])
	// Another account can't take the computer over by naming it.
	const { api_key: other } = await me(await signIn('squatter'))
	await server.fetch(SITE + '/api/v1/events', { method: 'POST', body: line(now - 60_000, 'UserPromptSubmit', { human: true }), headers: { Authorization: `Bearer ${other}`, 'X-Teardrop-Computer': pc } })
	const otherID = (await env.DB.prepare('SELECT id FROM users WHERE slack_id = ?').bind('USQUATTER').first<{ id: number }>())!.id
	await (env.HUB.get(env.HUB.idFromName(String(otherID))) as unknown as { flush(): Promise<string[]> }).flush()
	assert.equal((await env.DB.prepare('SELECT user_id FROM computers WHERE id = ?').bind(pc).first<{ user_id: number }>())!.user_id, id)
})

test('old log rows move to R2, and reviewers still read every one', async () => {
	const cookie = await signIn('longlog')
	const { api_key: key } = await me(cookie)
	const env = await server.getWorker<{ DB: { prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } } } }>().getEnv()
	const id = (await env.DB.prepare('SELECT id FROM users WHERE slack_id = ?').bind('ULONGLOG').first<{ id: number }>())!.id
	// 450 old rows, the oldest flagged, then one sync that archives the oldest 200.
	for (let i = 0; i < 450; i++) {
		await env.DB.prepare(`INSERT INTO account_log (user_id, at, event, computer_id, flagged, engaged_seconds) VALUES (?, ?, 'sync', 'td-old', ?, ?)`).bind(id, i, Number(i === 0), i).run()
	}
	const sync = computer()
	assert.equal((await call('/api/v1/reports', { method: 'POST', key, body: sync({ blocks: [], projects: [], engaged_seconds: 0 }) })).status, 200)
	const inD1 = await env.DB.prepare('SELECT COUNT(*) AS n FROM account_log WHERE user_id = ?').bind(id).first<{ n: number }>()
	assert.equal(inD1!.n, 251)
	const admin = await signIn('admin')
	const page = async (q = '') => (await (await call(`/api/review/person?id=${id}${q}`, { cookie: admin })).json()) as { counts: { entries: number; flagged: number }; log: { id: number; at: number }[]; more: number | null }
	const first = await page()
	assert.deepEqual([first.counts.entries, first.counts.flagged], [451, 1])
	// Page on until the oldest row, which is archived.
	let p = first, seen = first.log.length
	while (p.more) {
		p = await page(`&before=${p.more}`)
		seen += p.log.length
	}
	assert.equal(seen, 451)
	assert.equal(p.log.at(-1)!.at, 0)
	const flagged = await page('&show=flagged')
	assert.deepEqual(flagged.log.map((r) => r.at), [0])
	const all = (await (await call(`/api/review/log?id=${id}`, { cookie: admin })).json()) as { log: unknown[] }
	assert.equal(all.log.length, 451)
})

test('teardrop login connects a computer once, only by a typed code, and never for a banned account', async () => {
	const cookie = await signIn('connector')
	const { api_key } = await me(cookie)
	const start = async () => {
		const res = await call('/api/v1/login', { method: 'POST', body: JSON.stringify({ computer: 'td-abcdef012345' }) })
		assert.equal(res.status, 200)
		return (await res.json()) as { code: string; user_code: string; url: string }
	}
	const pollKey = async (code: string) => (await (await call(`/api/v1/login/${code}`)).json()) as { status?: string; key?: string; error?: string }
	const form = (fields: Record<string, string>, as = cookie, origin: string | undefined = SITE) =>
		server.fetch(SITE + '/connect', { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { Cookie: as, ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' })

	assert.equal((await call('/api/v1/login', { method: 'POST', body: '{"computer":"laptop"}' })).status, 400, 'a login names its computer')
	const login = await start()
	assert.match(login.user_code, /^[B-DF-HJ-NP-TV-XZ2-9]{4}-[B-DF-HJ-NP-TV-XZ2-9]{4}$/)
	assert.equal(login.url, `${SITE}/connect`)
	assert.equal((await pollKey(login.code)).status, 'pending')

	// Allowing takes a session, this site's own form, and the typed code; the code alone in a link does nothing.
	assert.equal((await call('/connect')).headers.get('Location'), '/login?next=%2Fconnect')
	assert.equal((await call(`/connect?user_code=${login.user_code}`, { cookie })).status, 200)
	assert.equal((await pollKey(login.code)).status, 'pending')
	assert.equal((await form({ user_code: login.user_code, decision: 'allow' }, cookie, 'https://evil.example')).status, 403)
	assert.equal((await form({ user_code: 'BBBB-BBBB', decision: 'allow' })).status, 400)
	assert.equal((await pollKey(login.code)).status, 'pending')
	// Typed loosely, the code shows the computer to check before connecting.
	const check = await form({ user_code: login.user_code.replace('-', ' ').toLowerCase() })
	assert.deepEqual([check.status, /td-abcdef012345/.test(await check.text())], [200, true])
	assert.equal((await pollKey(login.code)).status, 'pending')
	assert.equal((await form({ user_code: login.user_code, decision: 'allow' })).status, 200)
	assert.deepEqual(await pollKey(login.code), { status: 'done', key: api_key, name: '<b>connector</b>', handle: (await me(cookie)).handle })
	assert.equal((await call(`/api/v1/login/${login.code}`)).status, 410, 'the key is given once')
	assert.equal((await form({ user_code: login.user_code, decision: 'allow' })).status, 400, 'a code is allowed once')

	// Cancelled, or left too long, a login gives nothing.
	const denied = await start()
	await form({ user_code: denied.user_code, decision: 'deny' })
	assert.equal((await pollKey(denied.code)).status, 'denied')
	const late = await start()
	const env = await server.getWorker<{ DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } } }>().getEnv()
	await env.DB.prepare('UPDATE cli_logins SET expires_at = ? WHERE computer_id = ? AND allowed_at IS NULL AND denied_at IS NULL').bind(Date.now() - 1, 'td-abcdef012345').run()
	assert.equal((await form({ user_code: late.user_code, decision: 'allow' })).status, 400)
	assert.equal((await call(`/api/v1/login/${late.code}`)).status, 410)

	// A banned account connects nothing, and a login allowed before the ban gives no key after it.
	const before = await start()
	assert.equal((await form({ user_code: before.user_code, decision: 'allow' })).status, 200)
	const neo = await signIn('admin')
	const banned = await call('/api/review/bans', { method: 'POST', cookie: neo, origin: SITE, body: JSON.stringify({ slack_id: 'UCONNECTOR', reason: 'test' }) })
	assert.equal(banned.status, 200, await banned.text())
	assert.equal((await call(`/api/v1/login/${before.code}`)).status, 403)
	assert.equal((await call('/connect', { cookie })).status, 403)
})
