// Who is asking: sign-in with Hack Club Auth, the session cookie it leaves,
// and the sync keys that `teardrop sync` sends.
import { cookie, fromBase64Url, randomToken, redirect, Refusal, setCookie, toBase64Url } from './http.ts'

const SESSION_COOKIE = 'teardrop_session'
const STATE_COOKIE = 'teardrop_state'
const SESSION_SECONDS = 30 * 86400
const STATE_SECONDS = 600

export interface User {
	id: number
	slack_id: string
	name: string
	api_key: string
	/** Listed in ADMINS by Slack user ID. */
	admin: boolean
}

type UserRow = Omit<User, 'admin'>
const USER_COLUMNS = 'id, slack_id, name, api_key'

function withAdmin(env: Env, row: UserRow): User {
	const admins = (env.ADMINS ?? '').split(/[\s,]+/).filter(Boolean)
	return { ...row, admin: row.slack_id !== '' && admins.includes(row.slack_id) }
}

const newKey = () => 'tdk_' + randomToken(24)

async function hmacKey(env: Env): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** sign returns value with a signature only this server can make. */
async function sign(env: Env, value: string): Promise<string> {
	const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(value))
	return `${value}.${toBase64Url(new Uint8Array(sig))}`
}

/** unsign returns the value inside signed, or null if this server didn't sign it. */
async function unsign(env: Env, signed: string): Promise<string | null> {
	const dot = signed.lastIndexOf('.')
	const sig = dot < 0 ? null : fromBase64Url(signed.slice(dot + 1))
	if (!sig) return null
	const value = signed.slice(0, dot)
	const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), sig, new TextEncoder().encode(value))
	return ok ? value : null
}

/** devLogin is the Slack user ID every visitor is signed in as, on localhost only. */
function devLogin(request: Request, env: Env): string {
	const host = new URL(request.url).hostname
	return host === 'localhost' || host === '127.0.0.1' ? env.DEV_LOGIN : ''
}

/** saveUser creates the person's account on their first sign-in and updates it after. */
async function saveUser(env: Env, hcaID: string, slackID: string, name: string): Promise<User> {
	const row = await env.DB.prepare(
		`INSERT INTO users (hca_id, slack_id, name, api_key, created_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (hca_id) DO UPDATE SET slack_id = excluded.slack_id, name = excluded.name
		 RETURNING ${USER_COLUMNS}`,
	)
		.bind(hcaID, slackID, name, newKey(), Date.now())
		.first<UserRow>()
	return withAdmin(env, row!)
}

/** sessionUser returns who is signed in on request, or null. */
export async function sessionUser(request: Request, env: Env): Promise<User | null> {
	const dev = devLogin(request, env)
	if (dev) return saveUser(env, `dev:${dev}`, dev, 'Local tester')
	const value = await unsign(env, cookie(request, SESSION_COOKIE))
	const [id, expires] = (value ?? '').split('.').map(Number)
	if (!id || !expires || Date.now() / 1000 > expires) return null
	const row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first<UserRow>()
	return row && withAdmin(env, row)
}

/** keyUser returns whose sync key request carries, or null. */
export async function keyUser(request: Request, env: Env): Promise<User | null> {
	const key = /^Bearer (tdk_[A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') ?? '')?.[1]
	if (!key) return null
	const row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE api_key = ?`).bind(key).first<UserRow>()
	return row && withAdmin(env, row)
}

/** rotateKey replaces the person's sync key, so the old one stops working. */
export async function rotateKey(env: Env, user: User): Promise<string> {
	const key = newKey()
	await env.DB.prepare('UPDATE users SET api_key = ? WHERE id = ?').bind(key, user.id).run()
	return key
}

/** localPath returns next if it is a path on this site, and otherwise the dashboard. */
function localPath(next: string | null): string {
	return next && /^\/(?![/\\])/.test(next) ? next : '/dashboard'
}

/** startSignIn sends the visitor to Hack Club Auth. */
export async function startSignIn(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url)
	const next = localPath(url.searchParams.get('next'))
	if (devLogin(request, env)) return redirect(next)
	if (!env.HCA_CLIENT_ID) return redirect('/login?error=setup')
	const state = randomToken(16)
	const signed = await sign(env, toBase64Url(new TextEncoder().encode(`${state}|${next}`)))
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: env.HCA_CLIENT_ID,
		redirect_uri: `${url.origin}/auth/callback`,
		scope: 'openid profile slack_id',
		state,
	})
	return redirect(`${env.HCA_URL}/oauth/authorize?${query}`, [setCookie(request, STATE_COOKIE, signed, STATE_SECONDS)])
}

/** finishSignIn handles the visitor coming back from Hack Club Auth. */
export async function finishSignIn(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url)
	const clearState = setCookie(request, STATE_COOKIE, '', 0)
	const saved = fromBase64Url((await unsign(env, cookie(request, STATE_COOKIE))) ?? '')
	const [state, next] = new TextDecoder().decode(saved ?? new Uint8Array()).split('|')
	// The state proves this browser started the sign-in it is finishing.
	if (!state || url.searchParams.get('state') !== state) return redirect('/login?error=expired', [clearState])
	const code = url.searchParams.get('code')
	if (!code) return redirect('/login?error=cancelled', [clearState])
	let who: { sub: string; slack_id?: string; name?: string; nickname?: string }
	try {
		who = await hcaIdentity(env, code, `${url.origin}/auth/callback`)
	} catch (e) {
		console.error(JSON.stringify({ message: 'Hack Club Auth sign-in failed', error: String(e) }))
		return redirect('/login?error=failed', [clearState])
	}
	const user = await saveUser(env, who.sub, who.slack_id ?? '', (who.name ?? who.nickname ?? '').trim())
	const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS
	const session = await sign(env, `${user.id}.${expires}`)
	return redirect(localPath(next ?? null), [clearState, setCookie(request, SESSION_COOKIE, session, SESSION_SECONDS)])
}

/** hcaIdentity trades a sign-in code for the person it belongs to. */
async function hcaIdentity(env: Env, code: string, redirectURI: string) {
	const tokenRes = await fetch(`${env.HCA_URL}/oauth/token`, {
		method: 'POST',
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: env.HCA_CLIENT_ID,
			client_secret: env.HCA_CLIENT_SECRET,
			code,
			redirect_uri: redirectURI,
		}),
	})
	const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string }
	if (!token.access_token) throw new Error(`token: ${tokenRes.status} ${token.error ?? ''}`)
	const infoRes = await fetch(`${env.HCA_URL}/oauth/userinfo`, { headers: { Authorization: `Bearer ${token.access_token}` } })
	const info = (await infoRes.json().catch(() => ({}))) as { sub?: string; slack_id?: string; name?: string; nickname?: string }
	if (!infoRes.ok || !info.sub) throw new Error(`userinfo: ${infoRes.status}`)
	return { ...info, sub: info.sub }
}

export function signOut(request: Request): Response {
	return redirect('/', [setCookie(request, SESSION_COOKIE, '', 0)])
}

/**
 * sameOrigin refuses a request that changes something unless this site's own
 * pages sent it, so another site can't act as a signed-in visitor.
 */
export function sameOrigin(request: Request): void {
	if (request.headers.get('Origin') !== new URL(request.url).origin) {
		throw new Refusal(403, 'This request did not come from this site.')
	}
}
