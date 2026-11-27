// "Sign in with helios": another site sends a person to /authorize with
// where to send them back. They see what the site will read and choose Allow,
// and the site gets a code that it trades once, at POST /api/public/v1/token,
// for a read key of theirs. The key is like one made by hand under Settings,
// API, and is revoked there the same way.
import { keyHash, sameOrigin, sessionUser, type User, userByID } from './auth.ts'
import { readText, redirect, Refusal, randomToken, toBase64Url } from './http.ts'
import { createUserKey } from './public.ts'

/** How long a site has to trade a code. */
const CODE_LIFETIME = 5 * 60_000

/** A request to sign in, as the site sent it. */
export interface Ask {
	redirect: URL
	redirect_uri: string
	state: string
	name: string
	challenge: string
}

/**
 * readAsk checks what a site sent. It throws a Refusal, which the person
 * sees, for anything that can't be sent back, so nothing goes to an address
 * that isn't the site's own.
 */
export function readAsk(params: URLSearchParams): Ask {
	const redirect_uri = params.get('redirect_uri') ?? ''
	let redirect: URL
	try {
		redirect = new URL(redirect_uri)
	} catch {
		throw new Refusal(400, 'The site that sent you here gave no address to send you back to, so you can’t sign in to it with helios.')
	}
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
	if (!(redirect.protocol === 'https:' || (redirect.protocol === 'http:' && local)) || redirect.username || redirect.password || redirect.hash || redirect_uri.length > 2000) {
		throw new Refusal(400, 'The site that sent you here asked to be sent back to an address helios doesn’t send people to. It must use https.')
	}
	const challenge = params.get('code_challenge') ?? ''
	if (challenge && (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || (params.get('code_challenge_method') ?? 'S256') !== 'S256')) {
		throw new Refusal(400, 'The site that sent you here sent a code_challenge helios can’t check. It must be S256.')
	}
	const state = params.get('state') ?? ''
	if (state.length > 500) throw new Refusal(400, 'The site that sent you here sent a state longer than 500 characters.')
	// What the site calls itself. It could claim any name, so the page shows its address too.
	const name = (params.get('name') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || redirect.host
	return { redirect, redirect_uri, state, name, challenge }
}

/** back is where the person goes back to the site, with what it asked to get back. */
export function back(ask: Ask, add: Record<string, string>): string {
	const to = new URL(ask.redirect)
	for (const [k, v] of Object.entries(add)) to.searchParams.set(k, v)
	if (ask.state) to.searchParams.set('state', ask.state)
	return to.href
}

/** authorize answers GET and POST /authorize. */
export async function authorize(request: Request, env: Env, url: URL): Promise<Response> {
	let params = url.searchParams
	if (request.method === 'POST') {
		sameOrigin(request)
		params = new URLSearchParams(await readText(request, 16 << 10))
	}
	let ask: Ask
	try {
		ask = readAsk(params)
	} catch (e) {
		if (!(e instanceof Refusal)) throw e
		return page(e.status, 'Can’t sign in', `<p class="muted">${esc(e.message)}</p>`)
	}
	const user = await sessionUser(request, env)
	if (!user) {
		// Back here after signing in, with the same request. The query is rebuilt so it carries no stray characters.
		const again = new URLSearchParams([...params].filter(([k]) => k !== 'decision'))
		return redirect(`/login?next=${encodeURIComponent(`/authorize?${again}`)}`)
	}
	if (user.ban) {
		return page(403, 'This account is banned', `<p class="muted">A banned account can’t sign in to other sites with helios.</p>
			<a class="btn" href="${esc(back(ask, { error: 'access_denied' }))}">Back to ${esc(ask.redirect.host)}</a>`)
	}
	if (request.method === 'GET') return allowPage(ask, user)

	if (params.get('decision') !== 'allow') return redirect(back(ask, { error: 'access_denied' }))
	const code = 'tdc_' + randomToken(24)
	const now = Date.now()
	await env.DB.batch([
		// Codes no one traded are forgotten a day after they expire.
		env.DB.prepare('DELETE FROM sign_in_codes WHERE expires_at < ?').bind(now - 86400_000),
		env.DB.prepare('INSERT INTO sign_in_codes (hash, user_id, site, name, redirect_uri, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
			await keyHash(code),
			user.id,
			ask.redirect.origin,
			ask.name,
			ask.redirect_uri,
			ask.challenge,
			now,
			now + CODE_LIFETIME,
		),
	])
	return redirect(back(ask, { code }))
}

function allowPage(ask: Ask, user: User): Response {
	const hidden = Object.entries({ redirect_uri: ask.redirect_uri, state: ask.state, name: ask.name, code_challenge: ask.challenge })
		.map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
		.join('')
	return page(200, `Sign in to ${ask.name}`, `
		<p class="muted"><b class="site">${esc(ask.redirect.origin)}</b> would like to read your helios stats.</p>
		<ul class="grants">
			<li>Your name and Slack ID</li>
			<li>Your projects, with their repositories and hours</li>
			<li>Your hours on each day</li>
		</ul>
		<p class="fine muted">It can’t upload, change, or delete anything, and never sees folders on your computer. Revoke it any time under Settings, then API.</p>
		<form method="post" action="/authorize">${hidden}
			<button class="btn primary" name="decision" value="allow">Allow</button>
			<button class="btn" name="decision" value="deny">Cancel</button>
		</form>
		<p class="fine muted">Signed in as <b>${esc(user.name || user.slack_id)}</b>.</p>`)
}

/** page is a page of its own, with the look of the sign-in page. */
export function page(status: number, title: string, body: string): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${esc(title)} - helios</title>
	<link rel="icon" href="/favicon.svg">
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spline+Sans:wght@400;500;600;700&family=Spline+Sans+Mono:wght@400;500&display=swap">
	<link rel="stylesheet" href="/base.css">
	<link rel="stylesheet" href="/style.css">
	<script src="/theme.js"></script>
</head>
<body>
<main class="signin">
	<div>
		<div class="card authorize">
			<img class="logo" src="/logo.png" alt="">
			<h1>${esc(title)}</h1>
			${body}
		</div>
		<p class="back">with <a href="/">helios</a></p>
	</div>
</main>
</body>
</html>`
	return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * tradeCode answers POST /api/public/v1/token: a code from /authorize, with
 * the redirect_uri it was given for and the PKCE verifier if it had a
 * challenge, becomes a new read key. A code works once. Tried again, the key
 * it became is revoked, since someone else may have the code.
 */
export async function tradeCode(request: Request, env: Env): Promise<Response> {
	const text = await readText(request, 16 << 10)
	let body: Record<string, unknown>
	try {
		body = text.trimStart().startsWith('{') ? (JSON.parse(text) ?? {}) : Object.fromEntries(new URLSearchParams(text))
	} catch {
		throw new Refusal(400, 'Send code and redirect_uri as JSON or as a form.')
	}
	const code = String(body.code ?? '')
	const bad = new Refusal(400, 'That code is not valid. It may have expired or been used already. Send the person to /authorize again.')
	if (!/^tdc_[A-Za-z0-9_-]+$/.test(code)) throw bad
	const hash = await keyHash(code)
	const row = await env.DB.prepare('SELECT user_id, site, name, redirect_uri, challenge, expires_at, used_at, key_id FROM sign_in_codes WHERE hash = ?')
		.bind(hash)
		.first<{ user_id: number; site: string; name: string; redirect_uri: string; challenge: string; expires_at: number; used_at: number | null; key_id: number | null }>()
	if (!row) throw bad
	if (row.used_at != null) {
		if (row.key_id != null) await env.DB.prepare('DELETE FROM user_keys WHERE id = ?').bind(row.key_id).run()
		throw bad
	}
	if (Date.now() > row.expires_at) throw bad
	if (String(body.redirect_uri ?? '') !== row.redirect_uri) throw new Refusal(400, 'redirect_uri is not the one the code was made for.')
	if (row.challenge) {
		const verifier = new TextEncoder().encode(String(body.code_verifier ?? ''))
		if (toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', verifier))) !== row.challenge) throw new Refusal(400, 'code_verifier does not match the code_challenge.')
	}
	// Only the first of two requests at once gets a key.
	const taken = await env.DB.prepare('UPDATE sign_in_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL').bind(Date.now(), hash).run()
	if (!taken.meta.changes) throw bad
	const user = await userByID(env, row.user_id)
	if (!user) throw bad
	if (user.ban) throw new Refusal(403, 'This account is banned, so it can’t sign in to other sites.')
	const made = await createUserKey(env, user, { name: row.name }, row.site)
	await env.DB.prepare('UPDATE sign_in_codes SET key_id = ? WHERE hash = ?').bind(made.id, hash).run()
	return new Response(JSON.stringify({ key: made.key, token_type: 'Bearer', name: user.name, slack_id: user.slack_id }), {
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
	})
}
