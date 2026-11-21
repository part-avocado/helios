// Runs the Worker in the real Workers runtime with a local D1 database, and
// stands in for Hack Club Auth and the review server with a local HTTP server.
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
	const schema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
	for (const statement of unstable_splitSqlQuery(schema)) await env.DB.prepare(statement).run()
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
	return (await (await call('/api/me', { cookie })).json()) as { name: string; slack_id: string; admin: boolean; api_key: string; computers: { id: string }[] }
}

async function reports(cookie: string, query = '') {
	const res = await call('/api/report' + query, { cookie })
	assert.equal(res.status, 200)
	return ((await res.json()) as { computers: { id: string; report: { report: unknown } }[] }).computers
}

/** computer is a teardrop install: a signing key, and reports signed the way the CLI signs them. */
function computer() {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519')
	const account = publicKey.export({ format: 'jwk' }).x!
	return (report: object, generatedAt = Date.now()) => {
		const payload = JSON.stringify({
			account,
			generated_at: new Date(generatedAt).toISOString(),
			expires_at: new Date(generatedAt + 7 * DAY).toISOString(),
			since: '365d',
			teardrop_version: 'v0-test',
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

test('pages and data need an account', async () => {
	for (const page of ['/dashboard', '/settings.html', '/people']) {
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
		workers: [{ configPath: new URL('../wrangler.jsonc', import.meta.url), vars: { DEV_LOGIN: '' }, secrets: { SESSION_SECRET: 'x' } }],
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

test('only admins see other people', async () => {
	const member = await signIn('member')
	const admin = await signIn('admin')
	assert.equal((await me(admin)).admin, true)
	await call('/api/reports', { method: 'POST', body: computer()({ engaged_seconds: 600, blocks: [] }), cookie: member, origin: SITE })

	assert.equal((await call('/people', { cookie: member })).headers.get('Location'), '/dashboard')
	assert.equal((await call('/api/admin/people', { cookie: member })).status, 403)
	assert.equal((await call('/api/report?user=1', { cookie: member })).status, 403)

	assert.match(await (await call('/people', { cookie: admin })).text(), /<html[^>]* data-admin/)
	const { people } = (await (await call('/api/admin/people', { cookie: admin })).json()) as { people: { id: number; slack_id: string; engaged_seconds: number; computers: number }[] }
	const row = people.find((p) => p.slack_id === 'UMEMBER')!
	assert.deepEqual([row.engaged_seconds, row.computers], [600, 1])
	assert.equal((await reports(admin, `?user=${row.id}`)).length, 1)
	for (const id of ['999999', 'x', '1e3']) assert.equal((await call(`/api/report?user=${id}`, { cookie: admin })).status, 404, id)
})

test('project submissions go on to the review server', async () => {
	const { api_key: key } = await me(await signIn('submitter'))
	const body = JSON.stringify({ signed: { v: 1 }, logs: ['x'.repeat(200_000)] })
	assert.equal((await call('/api/v1/submissions', { method: 'POST', body })).status, 401)
	const res = await call('/api/v1/submissions', { method: 'POST', body, key })
	assert.deepEqual(await res.json(), { id: 'sub-0123456789abcdef' })
	assert.deepEqual(submissions, [body])
})
