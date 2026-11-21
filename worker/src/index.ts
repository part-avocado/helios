// The teardrop website on Cloudflare Workers. The pages are the files in
// ../site. This Worker adds accounts: sign-in with Hack Club Auth, each
// person's synced reports in D1, and the API the pages and the CLI use.
import { finishSignIn, keyUser, rotateKey, sameOrigin, sessionUser, signOut, startSignIn, type User } from './auth.ts'
import { json, jsonText, readText, redirect, Refusal } from './http.ts'
import { computers, MAX_REPORT_BYTES, removeComputer, reportsJSON, storeReport } from './reports.ts'

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
const PAGES: Record<string, boolean> = { dashboard: false, settings: false, people: true }

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname
	const call = `${request.method} ${path}`

	// The CLI, which sends a sync key.
	if (call === 'POST /api/v1/reports') {
		const user = await needKey(request, env, url)
		const id = await storeReport(env, user, await readText(request, MAX_REPORT_BYTES))
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
	const page = path.slice(1).replace(/\.html$/, '')
	if (request.method === 'GET' && page === 'login') {
		return user ? redirect('/dashboard') : env.ASSETS.fetch(request)
	}
	if (request.method === 'GET' && page in PAGES) {
		if (!user) return redirect(`/login?next=${encodeURIComponent(path + url.search)}`)
		if (PAGES[page] && !user.admin) return redirect('/dashboard')
		return accountPage(request, env, user)
	}

	// The API the pages use, with the visitor's session.
	if (!path.startsWith('/api/')) return new Response('Not found\n', { status: 404 })
	if (!user) throw new Refusal(401, 'Sign in first.')
	if (request.method !== 'GET') sameOrigin(request)
	if (call === 'GET /api/me') {
		return json({ name: user.name, slack_id: user.slack_id, admin: user.admin, api_key: user.api_key, computers: await computers(env, user.id) })
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
		return json({ computer: await storeReport(env, user, await readText(request, MAX_REPORT_BYTES)) })
	}
	if (call === 'POST /api/key') return json({ api_key: await rotateKey(env, user) })
	if (request.method === 'DELETE' && path.startsWith('/api/computers/')) {
		if (!(await removeComputer(env, user.id, path.slice('/api/computers/'.length)))) throw new Refusal(404, 'No such computer.')
		return json({})
	}
	if (call === 'GET /api/admin/people') {
		if (!user.admin) throw new Refusal(403, 'Admins only.')
		return json({ people: await people(env) })
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
 * accountPage serves one of the pages in PAGES, marked as signed in so it
 * shows the account's menu from the first paint.
 */
async function accountPage(request: Request, env: Env, user: User): Promise<Response> {
	// A fresh request, so the copy served is never "not modified" for someone else.
	const asset = await env.ASSETS.fetch(new Request(request.url))
	if (!asset.headers.get('Content-Type')?.includes('text/html')) return asset // a redirect to the page's tidy address
	const page = new HTMLRewriter()
		.on('html', {
			element(el) {
				el.setAttribute('data-hosted', '')
				if (user.admin) el.setAttribute('data-admin', '')
			},
		})
		.on('#account-name', {
			element(el) {
				el.setInnerContent(user.name || 'Account')
			},
		})
		.transform(asset)
	const headers = new Headers(page.headers)
	headers.set('Cache-Control', 'private, no-store')
	headers.delete('ETag')
	return new Response(page.body, { status: page.status, headers })
}

/** How many people the admin list shows. */
const PEOPLE_LIMIT = 1000

/** people lists everyone for admins, those who synced most recently first. */
async function people(env: Env) {
	const { results } = await env.DB.prepare(
		`SELECT u.id, u.name, u.slack_id, u.created_at, COUNT(c.id) AS computers,
			COALESCE(SUM(c.engaged_seconds), 0) AS engaged_seconds, MAX(c.synced_at) AS synced_at
		 FROM users u LEFT JOIN computers c ON c.user_id = u.id
		 GROUP BY u.id ORDER BY synced_at DESC NULLS LAST, u.created_at DESC LIMIT ${PEOPLE_LIMIT}`,
	).all()
	return results
}
