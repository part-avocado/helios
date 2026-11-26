// `helios login` connects a computer without anyone copying its sync key.
// The CLI asks for a login (POST /api/v1/login) and shows its person a short
// code. Signed in on the site, they type the code at /connect (or in the same
// form on the empty dashboard, which posts here), check the computer's ID,
// and allow it. The CLI, polling GET /api/v1/login/{code}
// with a secret code of its own, then gets a sync key of its own, once,
// named by its computer ID, which they can revoke alone under Settings.
//
// Someone could start a login and send the code to another person, to get
// their key. So the code must be typed, not followed from a link; the page
// says what allowing gives away and names the computer; a login lasts 10
// minutes and gives the key once. The allow page also says when and from
// where the login was asked for, which a code sent by someone else won't match.
import { createSyncKey, keyHash, sameOrigin, sessionUser, userByID } from './auth.ts'
import { json, readText, redirect, Refusal, randomToken } from './http.ts'
import { esc, page } from './signin.ts'

/** How long a login waits to be allowed and collected. */
const LIFETIME = 10 * 60_000
/** Letters for the typed code: no vowels, so it spells nothing, and none that look alike. */
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ23456789'

const typed = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** startLogin answers POST /api/v1/login from the CLI, which names its computer. */
export async function startLogin(request: Request, env: Env, url: URL): Promise<Response> {
	// Ten a minute from one address (LOGINS), so no one piles logins up in D1.
	if (!(await env.LOGINS.limit({ key: 'ip:' + (request.headers.get('CF-Connecting-IP') ?? '') })).success) {
		throw new Refusal(429, 'Too many logins from this address. Wait a minute, then run `helios login` again.', { 'Retry-After': '60' })
	}
	let body: { computer?: unknown }
	try {
		body = JSON.parse((await readText(request, 4 << 10)) || '{}')
	} catch {
		throw new Refusal(400, 'Send {"computer": "td-..."} as JSON.')
	}
	const computer = typeof body.computer === 'string' && /^td-[0-9a-f]{12}$/.test(body.computer) ? body.computer : ''
	if (!computer) throw new Refusal(400, 'Name the computer by its td- ID.')
	const code = 'tdl_' + randomToken(24)
	const pick = crypto.getRandomValues(new Uint8Array(8))
	const short = Array.from(pick, (b) => LETTERS[b % LETTERS.length]).join('')
	const now = Date.now()
	const cf = request.cf as { city?: string; country?: string } | undefined
	const place = [cf?.city, cf?.country].filter((p) => typeof p === 'string' && p).join(', ').slice(0, 200) || null
	await env.DB.batch([
		// Logins no one allowed are forgotten a day after they expire; allowed ones stay as a record.
		env.DB.prepare('DELETE FROM cli_logins WHERE expires_at < ? AND allowed_at IS NULL').bind(now - 86400_000),
		env.DB.prepare('INSERT INTO cli_logins (hash, user_code_hash, computer_id, created_at, expires_at, place) VALUES (?, ?, ?, ?, ?, ?)').bind(
			await keyHash(code),
			await keyHash(short),
			computer,
			now,
			now + LIFETIME,
			place,
		),
	])
	return json({ code, user_code: `${short.slice(0, 4)}-${short.slice(4)}`, url: `${url.origin}/connect`, expires_in: LIFETIME / 1000, interval: 2 })
}

/** pollLogin answers GET /api/v1/login/{code}: pending, denied, or the key, once. */
export async function pollLogin(env: Env, code: string): Promise<Response> {
	const gone = new Refusal(410, 'That login has expired or was used already. Run `helios login` again.')
	if (!/^tdl_[A-Za-z0-9_-]+$/.test(code)) throw gone
	const hash = await keyHash(code)
	const row = await env.DB.prepare('SELECT user_id, computer_id, expires_at, allowed_at, denied_at, collected_at FROM cli_logins WHERE hash = ?')
		.bind(hash)
		.first<{ user_id: number | null; computer_id: string; expires_at: number; allowed_at: number | null; denied_at: number | null; collected_at: number | null }>()
	if (!row || row.collected_at != null || Date.now() > row.expires_at) throw gone
	if (row.denied_at != null) return json({ status: 'denied' })
	if (row.allowed_at == null || row.user_id == null) return json({ status: 'pending' })
	// Only the first of two polls at once gets the key.
	const taken = await env.DB.prepare('UPDATE cli_logins SET collected_at = ? WHERE hash = ? AND collected_at IS NULL').bind(Date.now(), hash).run()
	if (!taken.meta.changes) throw gone
	const user = await userByID(env, row.user_id)
	if (!user) throw gone
	if (user.ban) throw new Refusal(403, 'This account is banned, so no computer can be connected to it.')
	// A computer that logs in again gets a new key, and its old one stops.
	// If none can be made, such as past the limit, the login waits to be polled again.
	try {
		const { key } = await createSyncKey(env, user, row.computer_id, true)
		return json({ status: 'done', key, name: user.name, handle: user.handle })
	} catch (e) {
		await env.DB.prepare('UPDATE cli_logins SET collected_at = NULL WHERE hash = ?').bind(hash).run()
		throw e
	}
}

/** connect answers GET and POST /connect, where a signed-in person allows a login by its code. */
export async function connect(request: Request, env: Env): Promise<Response> {
	const user = await sessionUser(request, env)
	if (!user) return redirect(`/login?next=${encodeURIComponent('/connect')}`)
	if (user.ban) return page(403, 'This account is banned', '<p class="muted">No computer can be connected to a banned account.</p>')
	if (request.method === 'GET') return codePage(200, '')

	sameOrigin(request)
	const form = new URLSearchParams(await readText(request, 4 << 10))
	const short = typed(form.get('user_code') ?? '')
	const row = short.length === 8
		? await env.DB.prepare('SELECT hash, computer_id, created_at, expires_at, allowed_at, denied_at, place FROM cli_logins WHERE user_code_hash = ?')
				.bind(await keyHash(short))
				.first<{ hash: string; computer_id: string; created_at: number; expires_at: number; allowed_at: number | null; denied_at: number | null; place: string | null }>()
		: null
	if (!row || Date.now() > row.expires_at || row.allowed_at != null || row.denied_at != null) {
		// Ten wrong codes a minute (LOGINS), so no one guesses another person's code.
		if (!(await env.LOGINS.limit({ key: `user:${user.id}` })).success) return codePage(429, 'Too many codes that didn’t match. Wait a minute, then type the code again.')
		return codePage(400, 'That code is not one helios is waiting for. Check it against your terminal, or run `helios login` again: a code lasts 10 minutes.')
	}
	const decision = form.get('decision')
	if (decision === 'deny') {
		await env.DB.prepare('UPDATE cli_logins SET denied_at = ? WHERE hash = ? AND allowed_at IS NULL').bind(Date.now(), row.hash).run()
		return page(200, 'Not connected', '<p class="muted">The computer was not connected. Your terminal will say so.</p>')
	}
	if (decision !== 'allow') return allowPage(short, row.computer_id, row.created_at, row.place, user.name || user.slack_id)
	const allowed = await env.DB.prepare('UPDATE cli_logins SET user_id = ?, allowed_at = ? WHERE hash = ? AND allowed_at IS NULL AND denied_at IS NULL')
		.bind(user.id, Date.now(), row.hash)
		.run()
	if (!allowed.meta.changes) return codePage(400, 'That code was used already. Run `helios login` again.')
	return page(200, 'Computer connected', `<p class="muted">Computer <b class="site">${esc(row.computer_id)}</b> is connected. Go back to your terminal; helios takes it from there.</p>
		<a class="btn primary" href="/dashboard.html">Go to your dashboard</a>`)
}

function codePage(status: number, error: string): Response {
	return page(status, 'Connect a computer', `
		<p class="muted">Type the code <code>helios login</code> shows in your terminal.</p>
		${error ? `<p class="msg bad" role="alert">${esc(error).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>` : ''}
		<form method="post" action="/connect">
			<input name="user_code" aria-label="The code from your terminal" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" maxlength="12" required autofocus>
			<button class="btn primary">Continue</button>
		</form>
		<p class="fine muted">Only type a code from your own terminal. If someone sent you a code, don’t: it would give them your account.</p>`)
}

function allowPage(short: string, computer: string, asked: number, place: string | null, who: string): Response {
	const minutes = Math.floor((Date.now() - asked) / 60_000)
	const when = minutes < 1 ? 'just now' : `${minutes} minute${minutes === 1 ? '' : 's'} ago`
	return page(200, 'Connect this computer?', `
		<p class="muted">Computer <b class="site">${esc(computer)}</b> asked to connect to your account ${when}${place ? `, from near <b>${esc(place)}</b>` : ''}. Check that <code>helios login</code> shows the same ID, and that you ran it then and there. If you didn't, cancel: someone sent you their code.</p>
		<ul class="grants">
			<li>It gets a sync key, so it can send records as you</li>
			<li>Revoking its key under Settings, then Setup, disconnects it alone</li>
		</ul>
		<form method="post" action="/connect">
			<input type="hidden" name="user_code" value="${esc(short)}">
			<button class="btn primary" name="decision" value="allow">Connect</button>
			<button class="btn" name="decision" value="deny">Cancel</button>
		</form>
		<p class="fine muted">Signed in as <b>${esc(who)}</b>.</p>`)
}
