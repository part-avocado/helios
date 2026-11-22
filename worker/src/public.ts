// The public API: what anyone with an account can read about themselves from
// a script or another site, with a read key they make in Settings. Its
// answers allow any origin, and it takes no cookies, so another site can call
// it from the browser with a key the person gave it. A banned person's keys
// read nothing.
import { keyHash, type User, userKeyUser } from './auth.ts'
import { json, randomToken, Refusal } from './http.ts'
import { tradeCode } from './signin.ts'
import { computers, personDays, personProjects, projectBlocks } from './reports.ts'
import { banMessage } from './staff.ts'

/** How many read keys one person may have. */
const MAX_KEYS = 20
/** How many read keys one site gets by signing in, one per browser or device. Signing in again past this revokes the oldest. */
const KEYS_PER_SITE = 5

/** userKeys lists a person's read keys, without the keys themselves, which are not kept. */
export async function userKeys(env: Env, user: User) {
	const { results } = await env.DB.prepare('SELECT id, name, hint, site, created_at, last_used_at FROM user_keys WHERE user_id = ? ORDER BY id DESC').bind(user.id).all()
	return results
}

/**
 * createUserKey makes a person a read key and returns it, the only time it is
 * shown. site is the origin of the site they signed in to with it, if any.
 */
export async function createUserKey(env: Env, user: User, body: { name?: unknown }, site = '') {
	const name = String(body.name ?? '').trim().slice(0, 60)
	if (!name) throw new Refusal(400, 'Name the key after what will use it, so you can tell your keys apart.')
	if (site) {
		await env.DB.prepare(
			`DELETE FROM user_keys WHERE user_id = ?1 AND site = ?2 AND id NOT IN (SELECT id FROM user_keys WHERE user_id = ?1 AND site = ?2 ORDER BY id DESC LIMIT ${KEYS_PER_SITE - 1})`,
		)
			.bind(user.id, site)
			.run()
	}
	const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_keys WHERE user_id = ?').bind(user.id).first<{ n: number }>()
	if ((have?.n ?? 0) >= MAX_KEYS) throw new Refusal(409, `You have ${MAX_KEYS} keys, which is the most one person can have. Revoke one under Settings, then API.`)
	const key = 'tdp_' + randomToken(24)
	const hint = key.slice(0, 9)
	const row = await env.DB.prepare('INSERT INTO user_keys (user_id, name, hash, hint, site, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
		.bind(user.id, name, await keyHash(key), hint, site, Date.now())
		.first<{ id: number }>()
	return { id: row!.id, name, hint, key }
}

/** revokeUserKey deletes one of a person's read keys, which stops working at once. */
export async function revokeUserKey(env: Env, user: User, id: string): Promise<void> {
	const gone = /^\d{1,15}$/.test(id) ? await env.DB.prepare('DELETE FROM user_keys WHERE id = ? AND user_id = ?').bind(Number(id), user.id).run() : null
	if (!gone?.meta.changes) throw new Refusal(404, 'No such key.')
}

/**
 * repo returns a project's repository, such as github.com/kid/site, when its
 * key is one on a public host. A key that is a folder on their computer, or a
 * repository on a machine at home, stays private.
 */
function repo(key: string): string | null {
	const host = /^([a-z0-9.-]+)(\/[^/\s]+){2,}$/i.exec(key)?.[1]?.toLowerCase()
	const labels = host?.split('.') ?? []
	if (labels.length < 2 || labels.some((l) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) return null
	if (!/^[a-z]{2,}$/.test(labels.at(-1)!) || ['local', 'lan', 'home', 'internal', 'localhost', 'localdomain', 'corp', 'intranet', 'private'].includes(labels.at(-1)!)) return null
	return key
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' }

/** publicAPI answers /api/public/v1/. Every answer, refusals too, may be read by any origin. */
export async function publicAPI(request: Request, env: Env, url: URL): Promise<Response> {
	let res: Response
	try {
		res = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await answer(request, env, url)
	} catch (e) {
		if (!(e instanceof Refusal)) throw e
		res = new Response(e.message + '\n', { status: e.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
	}
	for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v)
	return res
}

async function answer(request: Request, env: Env, url: URL): Promise<Response> {
	const call = `${request.method} ${url.pathname.slice('/api/public/v1'.length)}`
	// Where a site that a person signed in to trades its code for their read key.
	if (call === 'POST /token') return tradeCode(request, env)
	if (!/^Bearer tdp_/.test(request.headers.get('Authorization') ?? '')) {
		throw new Refusal(401, 'Send a read key as a bearer token. Make one on your teardrop site under Settings, then API.')
	}
	const user = await userKeyUser(request, env)
	if (!user) throw new Refusal(401, 'That read key is not valid. It may have been revoked.')
	if (user.ban) throw new Refusal(403, banMessage(user.ban))

	if (call === 'GET /me') {
		const theirs = await computers(env, user.id)
		return json({
			name: user.name,
			slack_id: user.slack_id,
			created_at: user.created_at,
			engaged_seconds: theirs.reduce((sum, c) => sum + c.engaged_seconds, 0),
			synced_at: theirs[0]?.synced_at ?? null,
		})
	}
	if (call === 'GET /projects') {
		const [totals, blocks] = await Promise.all([personProjects(env, user.id), projectBlocks(env, user.id)])
		const seen = new Map(blocks.map((p) => [p.key, p]))
		return json({
			projects: totals.map((p) => ({
				name: p.name,
				repo: repo(p.key),
				engaged_seconds: p.engaged_seconds,
				first_active: seen.get(p.key)?.first_active ?? null,
				last_active: seen.get(p.key)?.last_active ?? null,
			})),
		})
	}
	if (call === 'GET /days') {
		const perDay: Record<string, number> = {}
		for (const computer of await personDays(env, user.id)) for (const [date, s] of Object.entries(computer)) perDay[date] = (perDay[date] ?? 0) + s
		const since = url.searchParams.get('since') ?? ''
		return json({ days: Object.keys(perDay).sort().filter((d) => d >= since).map((date) => ({ date, engaged_seconds: perDay[date] })) })
	}
	throw new Refusal(404, 'Not found. The calls are GET /me, /projects, and /days, and POST /token.')
}
