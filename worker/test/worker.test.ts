// Runs the Worker in the real Workers runtime with a local D1 database, and
// stands in for Hack Club Auth and the review server with a local HTTP server.
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler'

// The Worker sees requests to this address as coming from the internet. A
// path alone reaches it as localhost.
const SITE = 'http://teardrop.example'
const DAY = 86400_000

const submissions: string[] = []
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
	if (req.url === '/api/v1/submissions') {
		submissions.push(body)
		return reply({ id: 'sub-0123456789abcdef' })
	}
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
				vars: { HCA_URL: fakeURL, REVIEW_SERVER: fakeURL, DEV_LOGIN: 'UDEV' },
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
	return (await (await call('/api/me', { cookie })).json()) as { name: string; slack_id: string; admin: boolean; level: number | null; ban: { reason: string; until: number | null } | null; api_key: string; computers: { id: string; cloud: boolean }[] }
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

	// Only admins, and only for people who exist.
	assert.equal((await call('/api/review/person?slack=ULOGGED', { cookie })).status, 403)
	assert.equal((await call('/review/', { cookie })).headers.get('Location'), '/dashboard')
	assert.equal((await call('/review/', { cookie: admin })).status, 200)
	for (const query of ['slack=UNOBODY', 'id=999999', 'id=1e3', '']) assert.equal((await call(`/api/review/person?${query}`, { cookie: admin })).status, 404, query)
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
		blocks: [block(Date.now() - 1000)],
		projects: [{ project: { key: '/home/kid/site', name: 'site' }, engaged_seconds: engaged_seconds - 1800 }, { project: { key: 'game', name: 'game' }, engaged_seconds: 1800 }],
	})
	const sync = async (engaged: number) => (await call('/api/v1/reports', { method: 'POST', body: laptop(report(engaged)), key: memberKey })).status
	assert.equal(await sync(5400), 200)
	const seen = (await (await review('/person?slack=uplain', rev)).json()) as { limited: boolean; projects: object[]; ban: { reason: string } | null }
	assert.deepEqual(Object.keys(seen).sort(), ['ban', 'engaged_seconds', 'flagged_reports', 'limited', 'person', 'projects', 'synced_at'])
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

	// Bans: for a time or until lifted, on people below the one who bans.
	const ban = (cookie: string, body: object) => review('/bans', cookie, 'POST', body)
	assert.equal((await ban(rev, { slack_id: 'UPLAIN', reason: 'no', days: 1 })).status, 403, 'a reviewer bans no one')
	assert.equal((await ban(neo, { slack_id: 'UPLAIN', reason: ' ', days: 1 })).status, 400, 'a ban needs a reason')
	assert.equal((await ban(neo, { slack_id: 'UPLAIN', reason: 'x', days: -1 })).status, 400)
	for (const above of ['UOTHERNEO', 'UNEO', 'UADMIN']) assert.equal((await ban(neo, { slack_id: above, reason: 'x' })).status, 403, above)
	assert.equal((await ban(superadmin, { slack_id: 'UOTHER', reason: 'x' })).status, 403, 'another superadmin')
	const temp = (await (await ban(neo, { slack_id: 'UPLAIN', reason: 'Edited reports', days: 7 })).json()) as { id: number; until: number }
	assert.ok(Math.abs(temp.until - (Date.now() + 7 * DAY)) < 60_000)
	// Nothing new is taken from them, and they are told why.
	const refused = await call('/api/v1/reports', { method: 'POST', body: laptop(report(6000)), key: memberKey })
	assert.equal(refused.status, 403)
	assert.match(await refused.text(), /banned until \d{4}-\d\d-\d\d \d\d:\d\d UTC.*Edited reports/)
	assert.equal((await call('/api/v1/events', { method: 'POST', body: '', key: memberKey })).status, 403)
	assert.equal((await call('/api/reports', { method: 'POST', body: laptop(report(6000)), cookie: member, origin: SITE })).status, 403)
	// They can still sign in and see what they had.
	const banned = await me(member)
	assert.deepEqual([banned.ban?.reason, banned.ban?.until], ['Edited reports', temp.until])
	const theirs = (await (await call('/api/report', { cookie: member })).json()) as { ban: { reason: string }; computers: object[] }
	assert.deepEqual([theirs.ban.reason, theirs.computers.length], ['Edited reports', 1])
	assert.equal(((await (await review('/person?slack=UPLAIN', rev)).json()) as typeof seen).ban?.reason, 'Edited reports')
	// Lifting it, and one that runs out.
	assert.deepEqual([await status(`/bans/${temp.id}`, rev, 'DELETE'), await status(`/bans/${temp.id}`, neo, 'DELETE'), await status(`/bans/${temp.id}`, neo, 'DELETE')], [403, 200, 404])
	assert.deepEqual([(await me(member)).ban, await sync(6000)], [null, 200])
	const short = (await (await ban(neo, { slack_id: 'UPLAIN', reason: 'again', days: 1 })).json()) as { id: number }
	assert.equal((await me(member)).ban?.reason, 'again')
	const env = await server.getWorker<{ DB: { prepare(sql: string): { run(): Promise<unknown> } } }>().getEnv()
	await env.DB.prepare(`UPDATE bans SET until = ${Date.now() - 1000} WHERE id = ${short.id}`).run()
	assert.equal((await me(member)).ban, null)

	// A banned reviewer can't review, and neither can their key. A neoadmin can't undo a superadmin's ban.
	const forever = (await (await ban(superadmin, { slack_id: 'UREV', reason: 'Left the team' })).json()) as { id: number; until: number | null }
	assert.equal(forever.until, null)
	assert.deepEqual([await status('/me', rev), (await withKey('/me', made.key)).status, (await call('/review/', { cookie: rev })).headers.get('Location')], [403, 403, '/dashboard'])
	assert.deepEqual([await status(`/bans/${forever.id}`, neo, 'DELETE'), (await ban(neo, { slack_id: 'UREV', reason: 'shorter', days: 1 })).status], [403, 403])
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

test('project submissions go on to the review server', async () => {
	const { api_key: key } = await me(await signIn('submitter'))
	const body = JSON.stringify({ signed: { v: 1 }, logs: ['x'.repeat(200_000)] })
	assert.equal((await call('/api/v1/submissions', { method: 'POST', body })).status, 401)
	const res = await call('/api/v1/submissions', { method: 'POST', body, key })
	assert.deepEqual(await res.json(), { id: 'sub-0123456789abcdef' })
	assert.deepEqual(submissions, [body])
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
