// The teardrop website on Cloudflare Workers. The pages are the files in
// ../site. This Worker adds accounts: sign-in with Hack Club Auth, each
// person's synced reports in D1, and the API the pages and the CLI use. The
// review app, at /review/, is the files in ../site/review and the API under
// /api/review/.
import { clearSession, finishSignIn, keyUser, reviewKeyUser, rotateKey, sameOrigin, sessionUser, signOut, startSignIn, type User, userByID } from './auth.ts'
import { cloudComputer, holdEvents, MAX_EVENTS_BYTES, readEvents } from './events.ts'
import { json, jsonText, readText, redirect, Refusal } from './http.ts'
import { checkGit } from './git.ts'
import { connect, pollLogin, startLogin } from './connect.ts'
import { relayRecords } from './records.ts'
import { accept, importRecords, listSubmissions, submission, submit } from './submissions.ts'
export { UserHub } from './hub.ts'
import { ownProfile, updateProfile, visibleOwner } from './profile.ts'
import { createUserKey, publicAPI, revokeUserKey, userKeys } from './public.ts'
import { computerReportJSON, computers, deleteUser, keptReportJSON, MAX_REPORT_BYTES, removeComputer, reportsJSON, storeReport } from './reports.ts'
import { fullLog, people, person, summary } from './review.ts'
import { authorize } from './signin.ts'
import { addReviewer, banMessage, bans, createKey, issueBan, keys, liftBan, need, removeReviewer, revokeKey, team } from './staff.ts'

export default {
	async fetch(request, env): Promise<Response> {
		try {
			const res = await route(request, env)
			// A WebSocket's answer goes back as the hub made it.
			return res.status === 101 ? res : guard(res)
		} catch (e) {
			if (e instanceof Refusal) return guard(new Response(e.message + '\n', { status: e.status, headers: { 'Cache-Control': 'no-store' } }))
			console.error(JSON.stringify({ message: 'request failed', path: new URL(request.url).pathname, error: String(e), stack: (e as Error)?.stack }))
			return guard(new Response('Something went wrong on the server. Try again in a moment.\n', { status: 500 }))
		}
	},
	// Hourly: ask GitHub which claimed commits exist.
	async scheduled(_event, env, ctx) {
		ctx.waitUntil(checkGit(env).then(() => {}))
	},
} satisfies ExportedHandler<Env>

/**
 * guard adds the headers that stop another site from showing these pages in
 * a frame, a browser from guessing a response's type, and a link out of the
 * site from carrying the address the visitor was on.
 */
function guard(res: Response): Response {
	const out = new Response(res.body, res) // a copy, since a fetched response's headers can't be changed
	out.headers.set('X-Frame-Options', 'DENY')
	out.headers.set('X-Content-Type-Options', 'nosniff')
	out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
	return out
}

/** jsonBody reads a small JSON object from a request. */
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const value = JSON.parse(await readText(request, 16 << 10))
		if (value && typeof value === 'object') return value
	} catch {}
	throw new Refusal(400, 'Send the details as a JSON object.')
}

/** liveView hands a live request to the person's hub, which answers a WebSocket or the state as JSON. */
async function liveView(env: Env, userID: number, request: Request, tag: 'owner' | 'public'): Promise<Response> {
	const hub = env.HUB.get(env.HUB.idFromName(String(userID)))
	const headers = new Headers({ 'X-Live': tag })
	if (request.headers.get('Upgrade') === 'websocket') headers.set('Upgrade', 'websocket')
	else if (new URL(request.url).pathname.endsWith('/ws')) throw new Refusal(426, 'Open this as a WebSocket.')
	const res = await hub.fetch('https://hub/live', { headers })
	if (res.webSocket) return res
	return new Response(res.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

/** Pages that need an account. */
const PAGES = new Set(['dashboard', 'settings'])

/** Addresses the review app had before it moved to /review/, and ones a reviewer might try. */
const REVIEW_ALIASES = new Set(['review', 'reviews', 'reviewer', 'admin', 'people', 'person'])

/** Pages anyone can read. A signed-in visitor sees them with their account menu. */
const PUBLIC = new Set(['', 'index', 'docs'])

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname
	const call = `${request.method} ${path}`
	const page = path.slice(1).replace(/\.html$/, '')

	// The home page and docs work without an account, or even before the secrets are set.
	if (request.method === 'GET' && PUBLIC.has(page)) {
		const visitor = await sessionUser(request, env).catch(() => null)
		return servePage(request, env, visitor)
	}
	// Public profiles. One no one may see is "not found", the same as one that doesn't exist.
	if (request.method === 'GET' && path.startsWith('/@')) {
		const [visitor, owner] = await Promise.all([sessionUser(request, env).catch(() => null), visibleOwner(env, path.slice(2))])
		const page = await servePage(new Request(new URL('/profile', url)), env, visitor)
		return owner ? page : new Response(page.body, { status: 404, headers: page.headers })
	}

	// Until the secrets are set, say so plainly instead of failing in some other place.
	const missing = ['SESSION_SECRET', 'HCA_CLIENT_ID', 'HCA_CLIENT_SECRET', 'ADMINS'].filter((name) => !env[name as keyof Env])
	if (missing.length && !env.DEV_LOGIN) {
		throw new Refusal(503, `This server is not set up yet. Add ${missing.join(', ')} under the Worker's Settings, Variables and Secrets, in the Cloudflare dashboard.`)
	}

	// The CLI, which sends a sync key.
	if (call === 'POST /api/v1/reports') {
		const user = await needKey(request, env, url)
		const id = await storeReport(env, user, await readText(request, MAX_REPORT_BYTES), 'sync')
		return json({ account: id, url: `${url.origin}/dashboard` })
	}
	// Amp's cloud plugin sends events, and reads them back to count them.
	if (call === 'POST /api/v1/events') {
		const user = await needKey(request, env, url)
		const body = await readText(request, MAX_EVENTS_BYTES)
		// Amp cloud events are also kept the old way, for cloud plugins that still count them themselves. A computer's own records are not.
		const cloud = (request.headers.get('X-Teardrop-Computer') ?? 'cloud') === 'cloud'
		const [records, stored] = await Promise.all([relayRecords(env, user, request, body), cloud ? holdEvents(env, user, body) : 0])
		// dropped_future tells the CLI its clock runs fast, which it says.
		return json({ stored, records: records.stored, ...(records.future ? { dropped_future: records.future } : {}) })
	}
	// `teardrop login`: the CLI asks to connect, then polls until its person allows it at /connect.
	if (call === 'POST /api/v1/login') return startLogin(request, env, url)
	if (request.method === 'GET' && path.startsWith('/api/v1/login/')) return pollLogin(env, path.slice('/api/v1/login/'.length))
	// Who a sync key belongs to, and this site's clock, for the CLI to compare its own against.
	if (call === 'GET /api/v1/whoami') {
		const user = await needKey(request, env, url)
		return json({ name: user.name, handle: user.handle, time: new Date().toISOString() })
	}
	if (call === 'GET /api/v1/cloud') return json(await readEvents(env, await needKey(request, env, url), url.searchParams))
	// teardrop v0.5.2 on a person's computer asks for cloud events to count
	// there. It takes "not found" to mean there are none for it, which is so.
	if (call === 'GET /api/v1/events') throw new Refusal(404, 'Cloud threads are counted in the cloud now.')
	// A submission is made from the records the site holds; nothing is uploaded with it.
	if (call === 'POST /api/v1/submissions') {
		const user = await needKey(request, env, url)
		return json(await submit(env, user, await jsonBody(request)))
	}

	// Signing in and out.
	if (call === 'GET /auth/hca') return startSignIn(request, env)
	if (call === 'GET /auth/callback') return finishSignIn(request, env)
	if (call === 'POST /logout') {
		sameOrigin(request)
		return signOut(request)
	}

	// Sign in with teardrop: another site asks for a read key, and the person allows it.
	if (path === '/authorize' && (request.method === 'GET' || request.method === 'POST')) return authorize(request, env, url)
	if (path === '/connect' && (request.method === 'GET' || request.method === 'POST')) return connect(request, env)

	// The review app decides who may open it, as for anyone who asks for it by name.
	if (request.method === 'GET' && REVIEW_ALIASES.has(page)) {
		const who = page !== 'person' ? '' : (url.searchParams.get('slack') ?? (url.searchParams.has('id') ? `id:${url.searchParams.get('id')}` : ''))
		return redirect('/review/' + (who ? `#/person/${encodeURIComponent(who)}` : ''))
	}
	if (path.startsWith('/api/review/')) return reviewAPI(request, env, url)
	// A profile's live view: whether its owner is at it now, never which project.
	const liveProfile = request.method === 'GET' ? /^\/api\/public\/v1\/users\/([^/]+)\/live$/.exec(path) : null
	if (liveProfile) {
		const owner = await visibleOwner(env, decodeURIComponent(liveProfile[1]!))
		if (!owner) throw new Refusal(404, 'No such profile.')
		return liveView(env, owner.id, request, 'public')
	}
	// What a person reads about themselves with a read key, from anywhere.
	if (path.startsWith('/api/public/v1/')) return publicAPI(request, env, url)

	const user = await sessionUser(request, env)
	if (request.method === 'GET' && page === 'login') {
		return user ? redirect('/dashboard') : env.ASSETS.fetch(request)
	}
	if (request.method === 'GET' && PAGES.has(page)) {
		if (!user) return redirect(`/login?next=${encodeURIComponent(path + url.search)}`)
		return servePage(request, env, user)
	}
	// The review app's page, styles, and script, for reviewers only.
	if (request.method === 'GET' && path.startsWith('/review/')) {
		if (!user) return redirect(`/login?next=${encodeURIComponent('/review/')}`)
		if (user.level == null) return redirect('/dashboard')
		return servePage(request, env, user)
	}

	// The API the pages use, with the visitor's session.
	if (!path.startsWith('/api/')) return new Response('Not found\n', { status: 404 })
	if (!user) throw new Refusal(401, 'Sign in first.')
	if (request.method !== 'GET') sameOrigin(request)
	if (call === 'GET /api/me') {
		// The computer their cloud threads sync as is named as such, since it is no machine of theirs.
		const cloud = (await cloudComputer(env, user)).id
		const all = (await computers(env, user.id)).map((c) => ({ ...c, cloud: c.id === cloud }))
		return json({ name: user.name, slack_id: user.slack_id, handle: user.handle, profile_public: user.profile_public, admin: user.admin, level: user.level, ban: ownBan(user), api_key: user.api_key, created_at: user.created_at, computers: all })
	}
	// Their own live view: a WebSocket that hears of each record as it arrives, or its state once.
	if (call === 'GET /api/live/ws' || call === 'GET /api/live') {
		if (call === 'GET /api/live/ws') sameOrigin(request)
		return liveView(env, user.id, request, 'owner')
	}
	if (call === 'GET /api/report') {
		// Neoadmins and superadmins can read anyone's reports; everyone else only their own.
		const other = url.searchParams.get('user')
		if (!other) return jsonText(`{"ban":${JSON.stringify(ownBan(user))},"computers":${await reportsJSON(env, user.id)}}`)
		need(user, 1)
		const person = /^\d+$/.test(other)
			? await env.DB.prepare('SELECT id, name, slack_id FROM users WHERE id = ?').bind(Number(other)).first<{ id: number }>()
			: null
		if (!person) throw new Refusal(404, 'No such person.')
		return jsonText(`{"person":${JSON.stringify(person)},"computers":${await reportsJSON(env, person.id)}}`)
	}
	if (call === 'POST /api/submissions') {
		if (user.ban) throw new Refusal(403, banMessage())
		return json(await submit(env, user, await jsonBody(request)))
	}
	if (call === 'POST /api/reports') {
		if (user.ban) throw new Refusal(403, banMessage())
		return json({ computer: await storeReport(env, user, await readText(request, MAX_REPORT_BYTES), 'upload') })
	}
	if (call === 'GET /api/export') {
		// The visitor's profile and their computers' latest reports, as a file to keep. The sync key stays out of it.
		const body = `{"exported_at":${Date.now()},"profile":${JSON.stringify({ name: user.name, slack_id: user.slack_id, handle: user.handle, created_at: user.created_at })},"computers":${await reportsJSON(env, user.id)}}`
		return new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="teardrop-data.json"', 'Cache-Control': 'no-store' } })
	}
	if (call === 'DELETE /api/account') {
		// Their stats go. The account's log stays for reviewers.
		await deleteUser(env, user.id)
		const res = json({})
		res.headers.append('Set-Cookie', clearSession(request))
		return res
	}
	if (call === 'POST /api/key') return json({ api_key: await rotateKey(env, user) })
	// Their public profile: its handle, whether it is public, and which projects it names.
	if (call === 'GET /api/profile') return json(await ownProfile(env, user))
	if (call === 'POST /api/profile') {
		let body: Record<string, unknown> = {}
		try {
			body = JSON.parse(await readText(request, 64 << 10)) ?? {}
		} catch {
			throw new Refusal(400, 'Send the changes as a JSON object.')
		}
		await updateProfile(env, user, body)
		return json(await ownProfile(env, (await userByID(env, user.id))!))
	}
	// Their read keys for the public API.
	if (call === 'GET /api/keys') return json({ keys: await userKeys(env, user) })
	if (call === 'POST /api/keys') {
		let body: Record<string, unknown> = {}
		try {
			body = JSON.parse(await readText(request, 16 << 10)) ?? {}
		} catch {}
		return json(await createUserKey(env, user, body))
	}
	if (request.method === 'DELETE' && path.startsWith('/api/keys/')) {
		await revokeUserKey(env, user, path.slice('/api/keys/'.length))
		return json({})
	}
	if (request.method === 'DELETE' && path.startsWith('/api/computers/')) {
		if (!(await removeComputer(env, user.id, path.slice('/api/computers/'.length)))) throw new Refusal(404, 'No such computer.')
		return json({})
	}
	throw new Refusal(404, 'Not found')
}

/** needKey returns whose sync key the CLI sent, and says how to get one otherwise. */
async function needKey(request: Request, env: Env, url: URL): Promise<User> {
	const user = await keyUser(request, env)
	if (!user) {
		throw new Refusal(401, `This server needs your sync key. Sign in at ${url.origin}/settings and run the command it shows under Setup.`)
	}
	if (user.ban) throw new Refusal(403, banMessage())
	return user
}

/**
 * ownBan is what a person is told of their own ban: that it holds until it is
 * lifted. The reason is for reviewers. until is always null; pages from before
 * bans lost their length read it.
 */
const ownBan = (user: User) => (user.ban ? { until: null } : null)

/**
 * reviewAPI answers the review app, and reviewers' own tools: it takes a
 * signed-in reviewer's session or a review key, which acts as the reviewer
 * who made it. What each level may do is in staff.ts.
 */
async function reviewAPI(request: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname.slice('/api/review'.length)
	const call = `${request.method} ${path}`
	const byKey = /^Bearer tdr_/.test(request.headers.get('Authorization') ?? '')
	const actor = byKey ? await reviewKeyUser(request, env) : await sessionUser(request, env)
	if (!actor) throw new Refusal(401, byKey ? 'That review key is not valid. It may have been revoked.' : 'Sign in first, or send a review key.')
	if (!byKey && request.method !== 'GET') sameOrigin(request)
	const level = need(actor, 2)
	const body = async (): Promise<Record<string, unknown>> => {
		const text = await readText(request, 16 << 10)
		try {
			const value = JSON.parse(text)
			if (value && typeof value === 'object') return value
		} catch {}
		throw new Refusal(400, 'Send the details as a JSON object.')
	}
	const rest = (prefix: string) => {
		try {
			return decodeURIComponent(path.slice(prefix.length))
		} catch {
			throw new Refusal(400, 'That address is not valid.')
		}
	}

	if (call === 'GET /me') return json({ name: actor.name, slack_id: actor.slack_id, level, by_key: byKey })
	// Submissions, which every level reviews; a reviewer sees project names only.
	if (call === 'GET /submissions') return json({ submissions: await listSubmissions(env, level) })
	// What the retired Go review server credited, from `teardrop export-records`.
	if (call === 'POST /import') {
		need(actor, 0)
		return json(await importRecords(env, await readText(request, 16 << 20)))
	}
	if (request.method === 'GET' && path.startsWith('/submissions/')) return json(await submission(env, rest('/submissions/'), level))
	if (request.method === 'POST' && /^\/submissions\/[^/]+\/accept$/.test(path)) {
		need(actor, 1)
		await accept(env, actor, path.split('/')[2]!, await body())
		return json({})
	}
	// A reviewer gets a person's totals per project. Those above get everything.
	if (call === 'GET /person') return json(level === 2 ? await summary(env, url.searchParams) : await person(env, actor, url.searchParams))

	// A reviewer's own keys. A key can't make or revoke keys, so one that leaks can't keep itself alive.
	if (path === '/keys' || path.startsWith('/keys/')) {
		if (byKey) throw new Refusal(403, 'Keys are made and revoked while signed in, not with a key.')
		if (call === 'GET /keys') return json({ keys: await keys(env, actor) })
		if (call === 'POST /keys') return json(await createKey(env, actor, await body()))
		if (request.method === 'DELETE' && path.startsWith('/keys/')) {
			await revokeKey(env, actor, rest('/keys/'))
			return json({})
		}
	}

	need(actor, 1)
	if (call === 'GET /people') return json({ people: await people(env) })
	if (call === 'GET /report') {
		// A report in full, as it was signed: the one behind a log entry, or a computer's latest.
		const entry = url.searchParams.get('entry')
		const report = entry === null ? await computerReportJSON(env, url.searchParams.get('computer') ?? '') : await keptReportJSON(env, entry)
		if (!report) throw new Refusal(404, entry === null ? 'No such computer.' : 'No report is kept for this entry.')
		return jsonText(report)
	}
	if (call === 'GET /log') {
		const log = await fullLog(env, url.searchParams)
		const res = json(log)
		res.headers.set('Content-Disposition', `attachment; filename="teardrop-log-${log.person.id}.json"`)
		return res
	}
	if (call === 'GET /team') return json(await team(env))
	if (call === 'POST /team') return json(await addReviewer(env, actor, await body()))
	if (request.method === 'DELETE' && path.startsWith('/team/')) {
		await removeReviewer(env, actor, rest('/team/'))
		return json({})
	}
	if (call === 'GET /bans') return json({ bans: await bans(env) })
	if (call === 'POST /bans') return json(await issueBan(env, actor, await body()))
	if (request.method === 'DELETE' && path.startsWith('/bans/')) {
		await liftBan(env, actor, rest('/bans/'))
		return json({})
	}
	throw new Refusal(404, 'Not found')
}

/**
 * servePage serves a page of the site. For a signed-in visitor it marks the
 * page, so it shows their account menu from the first paint.
 */
async function servePage(request: Request, env: Env, user: User | null): Promise<Response> {
	// A fresh request, so the copy served is never "not modified" for someone else.
	const asset = await env.ASSETS.fetch(new Request(request.url))
	if (!user || !asset.headers.get('Content-Type')?.includes('text/html')) return asset // or a redirect to the page's tidy address
	const page = new HTMLRewriter()
		.on('html', {
			element(el) {
				el.setAttribute('data-hosted', '')
				// Reviewers of any level get a link to the review app.
				if (user.level != null) el.setAttribute('data-staff', '')
			},
		})
		.on('#account-name, #account-name-full', {
			element(el) {
				el.setInnerContent(user.name || 'Account')
			},
		})
		.on('#account-initial', {
			element(el) {
				// The first letter or digit of their name.
				el.setInnerContent(Array.from(user.name).find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '?')
			},
		})
		.transform(asset)
	const headers = new Headers(page.headers)
	headers.set('Cache-Control', 'private, no-store')
	headers.delete('ETag')
	return new Response(page.body, { status: page.status, headers })
}
