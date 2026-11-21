// The teardrop website on Cloudflare Workers. The pages are the files in
// ../site. This Worker adds accounts: sign-in with Hack Club Auth, each
// person's synced reports in D1, and the API the pages and the CLI use.
import { clearSession, finishSignIn, keyUser, rotateKey, sameOrigin, sessionUser, signOut, startSignIn, type User } from './auth.ts'
import { json, jsonText, readText, redirect, Refusal } from './http.ts'
import { computers, deleteUser, MAX_REPORT_BYTES, removeComputer, reportsJSON, storeReport } from './reports.ts'
import { people, person } from './review.ts'

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env)
		} catch (e) {
			if (e instanceof Refusal) return new Response(e.message + '\n', { status: e.status, headers: { 'Cache-Control': 'no-store' } })
			console.error(JSON.stringify({ message: 'request failed', path: new URL(request.url).pathname, error: String(e), stack: (e as Error)?.stack }))
			return new Response('Something went wrong on the server. Try again in a moment.\n', { status: 500 })
		}
	},
} satisfies ExportedHandler<Env>

/** Pages that need an account. The value is whether they are for admins only. */
const PAGES: Record<string, boolean> = { dashboard: false, settings: false, people: true, person: true }

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
		return json({ name: user.name, slack_id: user.slack_id, admin: user.admin, api_key: user.api_key, created_at: user.created_at, computers: await computers(env, user.id) })
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
