// The teardrop website on Cloudflare Workers. The pages are the files in
// ../site. This Worker adds accounts: sign-in with Hack Club Auth, each
// person's synced reports in D1, and the API the pages and the CLI use.
import { clearSession, finishSignIn, keyUser, rotateKey, sameOrigin, sessionUser, signOut, startSignIn, type User } from './auth.ts'
import { cloudComputer, holdEvents, MAX_EVENTS_BYTES, readEvents } from './events.ts'
import { json, jsonText, readText, redirect, Refusal } from './http.ts'
import { computerReportJSON, computers, deleteUser, keptReportJSON, MAX_REPORT_BYTES, removeComputer, reportsJSON, storeReport } from './reports.ts'
import { fullLog, people, person } from './review.ts'

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return guard(await route(request, env))
		} catch (e) {
			if (e instanceof Refusal) return guard(new Response(e.message + '\n', { status: e.status, headers: { 'Cache-Control': 'no-store' } }))
			console.error(JSON.stringify({ message: 'request failed', path: new URL(request.url).pathname, error: String(e), stack: (e as Error)?.stack }))
			return guard(new Response('Something went wrong on the server. Try again in a moment.\n', { status: 500 }))
		}
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

/** Pages that need an account. The value is whether they are for admins only. */
const PAGES: Record<string, boolean> = { dashboard: false, settings: false, people: true, person: true }

/** Addresses an admin might try for the Review page, which is people.html. */
const REVIEW_ALIASES = new Set(['review', 'reviews', 'reviewer', 'admin'])

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
		return json({ stored: await holdEvents(env, user, body) })
	}
	if (call === 'GET /api/v1/cloud') return json(await readEvents(env, await needKey(request, env, url), url.searchParams))
	// teardrop v0.5.2 on a person's computer asks for cloud events to count
	// there. It takes "not found" to mean there are none for it, which is so.
	if (call === 'GET /api/v1/events') throw new Refusal(404, 'Cloud threads are counted in the cloud now.')
	if (call === 'POST /api/v1/submissions') {
		await needKey(request, env, url)
		if (!env.REVIEW_SERVER) throw new Refusal(501, 'This server does not take project submissions.')
		// Chat logs are large, so the upload is passed on as it arrives.
		return fetch(`${env.REVIEW_SERVER.replace(/\/+$/, '')}/api/v1/submissions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: request.body,
		})
	}

	// Signing in and out.
	if (call === 'GET /auth/hca') return startSignIn(request, env)
	if (call === 'GET /auth/callback') return finishSignIn(request, env)
	if (call === 'POST /logout') {
		sameOrigin(request)
		return signOut(request)
	}

	// The Review page decides who may open it, as for anyone who asks for it by name.
	if (request.method === 'GET' && REVIEW_ALIASES.has(page)) return redirect('/people')

	const user = await sessionUser(request, env)
	if (request.method === 'GET' && page === 'login') {
		return user ? redirect('/dashboard') : env.ASSETS.fetch(request)
	}
	if (request.method === 'GET' && page in PAGES) {
		if (!user) return redirect(`/login?next=${encodeURIComponent(path + url.search)}`)
		if (PAGES[page] && !user.admin) return redirect('/dashboard')
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
		return json({ name: user.name, slack_id: user.slack_id, admin: user.admin, api_key: user.api_key, created_at: user.created_at, computers: all })
	}
	if (call === 'GET /api/report') {
		// Admins can read anyone's reports; everyone else only their own.
		const other = url.searchParams.get('user')
		if (!other) return jsonText(`{"computers":${await reportsJSON(env, user.id)}}`)
		if (!user.admin) throw new Refusal(403, 'Admins only.')
		const person = /^\d+$/.test(other)
			? await env.DB.prepare('SELECT id, name, slack_id FROM users WHERE id = ?').bind(Number(other)).first<{ id: number }>()
			: null
		if (!person) throw new Refusal(404, 'No such person.')
		return jsonText(`{"person":${JSON.stringify(person)},"computers":${await reportsJSON(env, person.id)}}`)
	}
	if (call === 'POST /api/reports') {
		return json({ computer: await storeReport(env, user, await readText(request, MAX_REPORT_BYTES), 'upload') })
	}
	if (call === 'GET /api/export') {
		// The visitor's profile and their computers' latest reports, as a file to keep. The sync key stays out of it.
		const body = `{"exported_at":${Date.now()},"profile":${JSON.stringify({ name: user.name, slack_id: user.slack_id, created_at: user.created_at })},"computers":${await reportsJSON(env, user.id)}}`
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
	if (request.method === 'DELETE' && path.startsWith('/api/computers/')) {
		if (!(await removeComputer(env, user.id, path.slice('/api/computers/'.length)))) throw new Refusal(404, 'No such computer.')
		return json({})
	}
	if (path.startsWith('/api/admin/')) {
		if (!user.admin) throw new Refusal(403, 'Admins only.')
		if (call === 'GET /api/admin/people') return json({ people: await people(env) })
		if (call === 'GET /api/admin/person') return json(await person(env, url.searchParams))
		if (call === 'GET /api/admin/report') {
			// A report in full, as it was signed: the one behind a log entry, or a computer's latest.
			const entry = url.searchParams.get('entry')
			const report = entry === null ? await computerReportJSON(env, url.searchParams.get('computer') ?? '') : await keptReportJSON(env, entry)
			if (!report) throw new Refusal(404, entry === null ? 'No such computer.' : 'No report is kept for this entry.')
			return jsonText(report)
		}
		if (call === 'GET /api/admin/log') {
			const log = await fullLog(env, url.searchParams)
			const res = json(log)
			res.headers.set('Content-Disposition', `attachment; filename="teardrop-log-${log.person.id}.json"`)
			return res
		}
	}
	throw new Refusal(404, 'Not found')
}

/** needKey returns whose sync key the CLI sent, and says how to get one otherwise. */
async function needKey(request: Request, env: Env, url: URL): Promise<User> {
	const user = await keyUser(request, env)
	if (!user) {
		throw new Refusal(401, `This server needs your sync key. Sign in at ${url.origin}/settings and run the command it shows under Setup.`)
	}
	return user
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
				if (user.admin) el.setAttribute('data-admin', '')
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
