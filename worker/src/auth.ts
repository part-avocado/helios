// Who is asking: sign-in with Hack Club Auth, the session cookie it leaves,
// the sync keys that `teardrop sync` sends, and the keys reviewers make.
import { cookie, fromBase64Url, randomToken, redirect, Refusal, setCookie, toBase64Url } from './http.ts'

const SESSION_COOKIE = 'teardrop_session'
const STATE_COOKIE = 'teardrop_state'
const SESSION_SECONDS = 30 * 86400
const STATE_SECONDS = 600

/** A place in the review app: 0 for a superadmin, 1 for a neoadmin, 2 for a reviewer. See staff.ts. */
export type Level = 0 | 1 | 2

export interface User {
	id: number
	slack_id: string
	name: string
	/** The address of their public profile, /@handle. */
	handle: string
	/** Whether anyone may see that profile. */
	profile_public: boolean
	api_key: string
	/** Unix milliseconds. */
	created_at: number
	/** Listed in ADMINS by Slack user ID, which makes them a superadmin. */
	admin: boolean
	/** Their place in the review app, or null for someone with none. A banned person has none. */
	level: Level | null
	/** The ban on them that is in force, if there is one. */
	ban: { reason: string } | null
}

type UserRow = Omit<User, 'admin' | 'level' | 'ban' | 'profile_public'> & { profile_public: number; reviewer_level: number | null; ban: string | null }

/**
 * Selects a User's columns, with the level the reviewers table gives them and
 * the ban on them that is in force. A condition on users u follows it, with
 * ?2 standing for its value.
 */
const USER_QUERY = `SELECT u.id, u.slack_id, u.name, u.handle, u.profile_public, u.api_key, u.created_at,
	(SELECT r.level FROM reviewers r WHERE r.slack_id = u.slack_id) AS reviewer_level,
	(SELECT json_object('reason', b.reason) FROM bans b
	 WHERE b.slack_id = u.slack_id AND b.lifted_at IS NULL ORDER BY b.id DESC LIMIT 1) AS ban
	FROM users u WHERE u.deleted_at IS NULL AND`

/** superadmins lists the Slack IDs in ADMINS. */
export function superadmins(env: Env): string[] {
	return (env.ADMINS ?? '').split(/[\s,]+/).filter(Boolean)
}

/** load returns the first person that where picks out. It is SQL about users u, with ?2 standing for value. */
async function load(env: Env, where: string, value: string | number): Promise<User | null> {
	// ?1 is unused, so the conditions callers pass keep their numbering.
	const row = await env.DB.prepare(`${USER_QUERY} ${where} ORDER BY u.id LIMIT 1`).bind(null, value).first<UserRow>()
	if (!row) return null
	const { reviewer_level, ban: stored, profile_public, ...rest } = row
	const admin = rest.slack_id !== '' && superadmins(env).includes(rest.slack_id)
	// A superadmin can't be banned, so a ban from before they were one doesn't hold.
	const ban = admin || !stored ? null : (JSON.parse(stored) as User['ban'])
	const level = admin ? 0 : ban ? null : reviewer_level === 1 ? 1 : reviewer_level === 2 ? 2 : null
	return { ...rest, handle: rest.handle ?? '', profile_public: profile_public === 1, admin, level, ban }
}

export const newKey = () => 'tdk_' + randomToken(24)

async function hmacKey(env: Env): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/**
 * derived returns 32 bytes that only this server can make for label, the
 * same ones each time. No label is a value that sign is given.
 */
export async function derived(env: Env, label: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(label)))
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

/**
 * saveUser creates the person's account on their first sign-in and updates it
 * after. An account they had deleted is theirs again, empty but with its log.
 * Every account gets a neutral handle, never one made from their name, which
 * may be a real one.
 */
async function saveUser(env: Env, hcaID: string, slackID: string, name: string): Promise<User> {
	const row = await env.DB.prepare(
		`INSERT INTO users (hca_id, slack_id, name, api_key, created_at, handle) VALUES (?, ?, ?, ?, ?, 'u-' || lower(hex(randomblob(6))))
		 ON CONFLICT (hca_id) DO UPDATE SET slack_id = excluded.slack_id, name = excluded.name, deleted_at = NULL,
			handle = coalesce(users.handle, excluded.handle)
		 RETURNING id`,
	)
		.bind(hcaID, slackID, name, newKey(), Date.now())
		.first<{ id: number }>()
	return (await load(env, 'u.id = ?2', row!.id))!
}

/** sessionUser returns who is signed in on request, or null. */
export async function sessionUser(request: Request, env: Env): Promise<User | null> {
	const dev = devLogin(request, env)
	if (dev) return saveUser(env, `dev:${dev}`, dev, 'Local tester')
	const value = await unsign(env, cookie(request, SESSION_COOKIE))
	const [id, expires] = (value ?? '').split('.').map(Number)
	if (!id || !expires || Date.now() / 1000 > expires) return null
	return load(env, 'u.id = ?2', id)
}

/** userByID returns the person with this account ID, or null for one deleted or unknown. */
export const userByID = (env: Env, id: number) => load(env, 'u.id = ?2', id)

/** userByHandle returns the person whose profile is /@handle, or null for one deleted or unknown. */
export const userByHandle = (env: Env, handle: string) => load(env, 'u.handle = ?2', handle.toLowerCase())

/** keyUser returns whose sync key request carries, or null. */
export async function keyUser(request: Request, env: Env): Promise<User | null> {
	const key = /^Bearer (tdk_[A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') ?? '')?.[1]
	if (!key) return null
	// The account's own key, else one of its other sync keys.
	const own = await load(env, 'u.api_key = ?2', key)
	if (own) return own
	const row = await env.DB.prepare('SELECT id, user_id FROM sync_keys WHERE hash = ?').bind(await keyHash(key)).first<{ id: number; user_id: number }>()
	if (!row) return null
	await env.DB.prepare('UPDATE sync_keys SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - 60000)').bind(Date.now(), row.id).run()
	return load(env, 'u.id = ?2', row.user_id)
}

/** The most sync keys one person has beside the account's own. */
const MAX_SYNC_KEYS = 50

/** syncKeys lists a person's sync keys beside the account's own, newest first, without the keys. */
export async function syncKeys(env: Env, user: User) {
	const { results } = await env.DB.prepare('SELECT id, name, hint, created_at, last_used_at FROM sync_keys WHERE user_id = ? ORDER BY id DESC').bind(user.id).all()
	return results
}

/**
 * createSyncKey makes a person a sync key named name, and returns it, the
 * only time it is shown. With replace, it replaces their key of that name,
 * as a computer that logs in again does.
 */
export async function createSyncKey(env: Env, user: User, name: string, replace = false) {
	name = name.trim().slice(0, 60)
	if (!name) throw new Refusal(400, 'Name the key after the computer or tool that will use it, so you can tell your keys apart.')
	const key = newKey()
	const hint = key.slice(0, 9)
	const hash = await keyHash(key)
	// The limit is counted in the insert itself, so two made at once can't
	// both pass it, and leaves out the key this one replaces. That one goes in
	// the same batch, and only once the new one is in, so a computer that
	// logs in again is never left with none.
	const [made] = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO sync_keys (user_id, name, hash, hint, created_at) SELECT ?1, ?2, ?3, ?4, ?5
			 WHERE (SELECT COUNT(*) FROM sync_keys WHERE user_id = ?1 AND (?6 = 0 OR name != ?2)) < ${MAX_SYNC_KEYS} RETURNING id`,
		).bind(user.id, name, hash, hint, Date.now(), replace ? 1 : 0),
		env.DB.prepare(`DELETE FROM sync_keys WHERE ?4 = 1 AND user_id = ?1 AND name = ?2 AND hash != ?3 AND EXISTS (SELECT 1 FROM sync_keys WHERE hash = ?3)`).bind(user.id, name, hash, replace ? 1 : 0),
	])
	const row = (made!.results as { id: number }[])[0]
	if (!row) throw new Refusal(409, `You have ${MAX_SYNC_KEYS} sync keys, which is the most one person can have. Revoke one under Settings, then Setup.`)
	return { id: row.id, name, hint, key }
}

/** revokeSyncKey deletes one of a person's sync keys, which stops working at once. */
export async function revokeSyncKey(env: Env, user: User, id: string): Promise<void> {
	const gone = /^\d{1,15}$/.test(id) ? await env.DB.prepare('DELETE FROM sync_keys WHERE id = ? AND user_id = ?').bind(Number(id), user.id).run() : null
	if (!gone?.meta.changes) throw new Refusal(404, 'No such key.')
}

/** keyHash is what the server keeps of a review key, which it can check a key against but not turn back into one. */
export async function keyHash(key: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
	return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * userKeyUser returns the person whose read key request carries, or null. It
 * notes when the key was last used, at most once a minute.
 */
export async function userKeyUser(request: Request, env: Env): Promise<User | null> {
	const key = /^Bearer (tdp_[A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') ?? '')?.[1]
	if (!key) return null
	const row = await env.DB.prepare('SELECT id, user_id FROM user_keys WHERE hash = ?').bind(await keyHash(key)).first<{ id: number; user_id: number }>()
	if (!row) return null
	await env.DB.prepare('UPDATE user_keys SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - 60000)').bind(Date.now(), row.id).run()
	return load(env, 'u.id = ?2', row.user_id)
}

/**
 * reviewKeyUser returns the reviewer whose review key request carries, or
 * null. The key acts as that person does now, so it does nothing once they
 * are removed or banned.
 */
export async function reviewKeyUser(request: Request, env: Env): Promise<User | null> {
	const key = /^Bearer (tdr_[A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') ?? '')?.[1]
	if (!key) return null
	const row = await env.DB.prepare('SELECT id, slack_id FROM review_keys WHERE hash = ?').bind(await keyHash(key)).first<{ id: number; slack_id: string }>()
	if (!row) return null
	// When it was last used is noted at most once a minute.
	await env.DB.prepare('UPDATE review_keys SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - 60000)').bind(Date.now(), row.id).run()
	return load(env, 'u.slack_id = ?2', row.slack_id)
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

/** clearSession is the cookie that ends the visitor's sign-in. */
export const clearSession = (request: Request) => setCookie(request, SESSION_COOKIE, '', 0)

export function signOut(request: Request): Response {
	return redirect('/', [clearSession(request)])
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
