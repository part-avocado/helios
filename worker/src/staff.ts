// The people who review, and what they may do. There are three levels:
//
//   0, superadmin: the Slack IDs in the ADMINS variable. They can do everything.
//   1, neoadmin: sees everything, adds and removes reviewers, and bans people.
//   2, reviewer: looks a person up and sees their totals per project.
//
// Neoadmins and reviewers are listed in the reviewers table, by Slack ID. A
// person can add, remove, or ban only those below their own level, so a
// neoadmin can't touch another neoadmin. Reviewers can make API keys, which
// act as they do. A ban has no length: it holds until someone lifts it.
import { keyHash, type Level, superadmins, type User } from './auth.ts'
import { randomToken, Refusal } from './http.ts'

/** Someone with no place in the review app, who ranks below every reviewer. */
const MEMBER = 3
type Rank = Level | typeof MEMBER
const RANK_NAMES = ['superadmin', 'neoadmin', 'reviewer', 'member']
/** How many API keys one reviewer may have. */
const MAX_KEYS = 20
/** How many bans and log rows the review app lists. */
const LISTED = 500

/** In SQL, the name of whoever has the Slack ID in column, if they have signed in. */
const nameOf = (column: string) => `(SELECT name FROM users u WHERE u.slack_id = ${column} AND u.deleted_at IS NULL ORDER BY u.id LIMIT 1)`

/** slackID reads a Slack ID as a person would paste it, such as u012abcdef or <@U012ABCDEF>. */
export function slackID(text: unknown): string {
	const id = String(text ?? '').trim().replace(/^<@|>$/g, '').toUpperCase()
	if (!/^[UW][A-Z0-9]{2,20}$/.test(id)) {
		throw new Refusal(400, 'That is not a Slack ID. One looks like U012ABCDEF: in Slack, open the profile, choose ⋮, then Copy member ID.')
	}
	return id
}

/** need returns the visitor's level, and refuses one who isn't at least at level. */
export function need(actor: User, level: Level): Level {
	if (actor.level == null || actor.level > level) {
		throw new Refusal(403, ['Superadmins only.', 'Neoadmins and superadmins only.', 'Reviewers only.'][level]!)
	}
	return actor.level
}

/** rankOf returns the level a Slack ID holds, whether or not they are banned. */
export async function rankOf(env: Env, slack: string): Promise<Rank> {
	if (superadmins(env).includes(slack)) return 0
	const row = await env.DB.prepare('SELECT level FROM reviewers WHERE slack_id = ?').bind(slack).first<{ level: number }>()
	return row?.level === 1 ? 1 : row?.level === 2 ? 2 : MEMBER
}

function log(env: Env, actor: User, action: string, slack: string, detail = ''): D1PreparedStatement {
	return env.DB.prepare('INSERT INTO staff_log (at, by_slack_id, action, slack_id, detail) VALUES (?, ?, ?, ?, ?)').bind(Date.now(), actor.slack_id, action, slack, detail)
}

/** team lists everyone who can review, and the latest changes to that list and to bans. */
export async function team(env: Env) {
	const admins = superadmins(env)
	const [reviewers, names, changes] = await Promise.all([
		env.DB.prepare(
			`SELECT r.slack_id, r.level, r.note, r.added_by, r.added_at, ${nameOf('r.slack_id')} AS name, ${nameOf('r.added_by')} AS added_by_name,
				EXISTS (SELECT 1 FROM bans b WHERE b.slack_id = r.slack_id AND b.lifted_at IS NULL) AS banned
			 FROM reviewers r ORDER BY r.level, r.added_at`,
		).all<{ slack_id: string; level: number; note: string; added_by: string; added_at: number; name: string | null; added_by_name: string | null; banned: number }>(),
		env.DB.prepare(`SELECT slack_id, name FROM users WHERE deleted_at IS NULL AND slack_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
			.bind(JSON.stringify(admins))
			.all<{ slack_id: string; name: string }>(),
		env.DB.prepare(
			`SELECT l.id, l.at, l.by_slack_id, l.action, l.slack_id, l.detail, ${nameOf('l.by_slack_id')} AS by_name, ${nameOf('l.slack_id')} AS name
			 FROM staff_log l ORDER BY l.id DESC LIMIT ${LISTED}`,
		).all(),
	])
	return {
		superadmins: admins.map((slack_id) => ({ slack_id, name: names.results.find((u) => u.slack_id === slack_id)?.name ?? null })),
		// Someone in ADMINS is a superadmin, whatever an older row here says.
		reviewers: reviewers.results.filter((r) => !admins.includes(r.slack_id)),
		log: changes.results,
	}
}

/**
 * access returns the level a Slack ID holds and what the visitor may change
 * of it: the levels they may give, whether they may remove or ban the person,
 * and whether they may lift or replace the ban the person has now. It answers
 * only what addReviewer, removeReviewer, issueBan, and liftBan would allow.
 */
export async function access(env: Env, actor: User, slack: string) {
	const mine = need(actor, 1)
	const has = await rankOf(env, slack)
	const below = has > mine
	const current = (await bans(env, slack)).find((b) => b.active)
	return {
		level: has === MEMBER ? null : has,
		levels: below ? [1, 2].filter((l) => l > mine && l !== has) : [],
		remove: below && has !== MEMBER,
		ban: below && !(current && current.by_level < mine),
		lift: Boolean(current) && current!.by_level >= mine,
	}
}

/**
 * addReviewer lets a person review, or changes the level of one who already
 * does. The level given, and the one they hold, must both be below the
 * visitor's own.
 */
export async function addReviewer(env: Env, actor: User, body: { slack_id?: unknown; level?: unknown; note?: unknown }) {
	const mine = need(actor, 1)
	const slack = slackID(body.slack_id)
	const level = Number(body.level)
	if (level !== 1 && level !== 2) throw new Refusal(400, 'Choose reviewer or neoadmin.')
	if (level <= mine) throw new Refusal(403, 'Only a superadmin can add a neoadmin.')
	const has = await rankOf(env, slack)
	if (has === 0) throw new Refusal(409, `${slack} is a superadmin, set in the ADMINS variable.`)
	if (has <= mine) throw new Refusal(403, `${slack} is a ${RANK_NAMES[has]}, and only a superadmin can change that.`)
	const note = String(body.note ?? '').trim().slice(0, 200)
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO reviewers (slack_id, level, note, added_by, added_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (slack_id) DO UPDATE SET level = excluded.level, note = excluded.note, added_by = excluded.added_by, added_at = excluded.added_at`,
		).bind(slack, level, note, actor.slack_id, Date.now()),
		log(env, actor, has === MEMBER ? 'add' : 'change', slack, `as a ${RANK_NAMES[level]}${has === MEMBER ? '' : `, was a ${RANK_NAMES[has]}`}`),
	])
	const name = await env.DB.prepare(`SELECT ${nameOf('?1')} AS name`).bind(slack).first<{ name: string | null }>()
	return { slack_id: slack, level, name: name?.name ?? null }
}

/** removeReviewer ends a person's reviewing, and their API keys with it. They must be below the visitor's level. */
export async function removeReviewer(env: Env, actor: User, id: string): Promise<void> {
	const mine = need(actor, 1)
	const slack = slackID(id)
	const has = await rankOf(env, slack)
	if (has === MEMBER) throw new Refusal(404, `${slack} is not a reviewer.`)
	if (has === 0) throw new Refusal(403, `${slack} is a superadmin. Take them out of the ADMINS variable instead.`)
	if (has <= mine) throw new Refusal(403, `${slack} is a neoadmin, and only a superadmin can remove one.`)
	await env.DB.batch([
		env.DB.prepare('DELETE FROM reviewers WHERE slack_id = ?').bind(slack),
		env.DB.prepare('DELETE FROM review_keys WHERE slack_id = ?').bind(slack),
		log(env, actor, 'remove', slack, `was a ${RANK_NAMES[has]}`),
	])
}

export interface BanRow {
	id: number
	slack_id: string
	reason: string
	by_slack_id: string
	by_level: number
	at: number
	/** The end a ban was given before bans lost their length, if it had one. */
	was_until: number | null
	lifted_at: number | null
	lifted_by: string | null
}

const BAN_COLUMNS = `b.id, b.slack_id, b.reason, b.by_slack_id, b.by_level, b.at, b.was_until, b.lifted_at, b.lifted_by,
	${nameOf('b.slack_id')} AS name, ${nameOf('b.by_slack_id')} AS by_name, ${nameOf('b.lifted_by')} AS lifted_by_name`

/** inForce says whether a ban still holds: every ban does until it is lifted. */
const inForce = (b: BanRow) => b.lifted_at == null

/**
 * The words a banned person is told, by the site and by `teardrop sync`. The
 * reason is for reviewers only, so it is left out.
 */
export function banMessage(): string {
	return 'This account is banned until a reviewer lifts the ban. Nothing new is taken from it: no syncs, uploads, cloud events, or submissions.'
}

/** bans lists bans, newest first, each marked with whether it is in force: everyone's, or one person's. */
export async function bans(env: Env, slack = '') {
	const { results } = await env.DB.prepare(`SELECT ${BAN_COLUMNS} FROM bans b WHERE ?1 = '' OR b.slack_id = ?1 ORDER BY b.id DESC LIMIT ${LISTED}`)
		.bind(slack)
		.all<BanRow & { name: string | null; by_name: string | null; lifted_by_name: string | null }>()
	return results.map((b) => ({ ...b, active: inForce(b) }))
}

/**
 * issueBan bans a person below the visitor's level until someone lifts the
 * ban. It replaces a ban already in force, unless someone above the visitor
 * issued that one.
 */
export async function issueBan(env: Env, actor: User, body: { slack_id?: unknown; reason?: unknown; days?: unknown }) {
	const mine = need(actor, 1)
	// A script that still asks for a length must not believe it issued a short ban.
	if ('days' in body) throw new Refusal(400, 'Bans have no length: each lasts until someone lifts it. Leave days out.')
	const slack = slackID(body.slack_id)
	const reason = String(body.reason ?? '').trim().slice(0, 500)
	if (!reason) throw new Refusal(400, 'Give a reason. Only reviewers see it, never the person.')
	const now = Date.now()
	const has = await rankOf(env, slack)
	if (has <= mine) throw new Refusal(403, `${slack} is a ${RANK_NAMES[has]}. You can ban only people below your own level.`)
	const current = (await bans(env, slack)).find((b) => b.active)
	if (current && current.by_level < mine) throw new Refusal(403, 'A superadmin issued the ban they have now, so only a superadmin can change it.')
	const [, added] = await env.DB.batch([
		env.DB.prepare('UPDATE bans SET lifted_at = ?1, lifted_by = ?2 WHERE slack_id = ?3 AND lifted_at IS NULL').bind(now, actor.slack_id, slack),
		env.DB.prepare('INSERT INTO bans (slack_id, reason, by_slack_id, by_level, at) VALUES (?, ?, ?, ?, ?) RETURNING id').bind(slack, reason, actor.slack_id, mine, now),
		log(env, actor, 'ban', slack, reason),
	])
	return { id: (added!.results[0] as { id: number }).id, slack_id: slack }
}

/** liftBan ends a ban early. Someone below the level of whoever issued it can't. */
export async function liftBan(env: Env, actor: User, id: string): Promise<void> {
	const mine = need(actor, 1)
	const now = Date.now()
	const ban = /^\d{1,15}$/.test(id) ? await env.DB.prepare('SELECT * FROM bans WHERE id = ?').bind(Number(id)).first<BanRow>() : null
	if (!ban || !inForce(ban)) throw new Refusal(404, 'No such ban, or it is already over.')
	if (ban.by_level < mine) throw new Refusal(403, 'A superadmin issued this ban, so only a superadmin can lift it.')
	await env.DB.batch([
		env.DB.prepare('UPDATE bans SET lifted_at = ?, lifted_by = ? WHERE id = ?').bind(now, actor.slack_id, ban.id),
		log(env, actor, 'unban', ban.slack_id),
	])
}

/** keys lists the visitor's own API keys, without the keys themselves, which are not kept. */
export async function keys(env: Env, actor: User) {
	need(actor, 2)
	const { results } = await env.DB.prepare('SELECT id, name, hint, created_at, last_used_at FROM review_keys WHERE slack_id = ? ORDER BY id DESC').bind(actor.slack_id).all()
	return results
}

/** createKey makes the visitor an API key and returns it, the only time it is shown. */
export async function createKey(env: Env, actor: User, body: { name?: unknown }) {
	need(actor, 2)
	const name = String(body.name ?? '').trim().slice(0, 60)
	if (!name) throw new Refusal(400, 'Name the key after what will use it, so you can tell your keys apart.')
	const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM review_keys WHERE slack_id = ?').bind(actor.slack_id).first<{ n: number }>()
	if ((have?.n ?? 0) >= MAX_KEYS) throw new Refusal(409, `You have ${MAX_KEYS} keys, which is the most one person can have. Revoke one first.`)
	const key = 'tdr_' + randomToken(24)
	const hint = key.slice(0, 9)
	const row = await env.DB.prepare('INSERT INTO review_keys (slack_id, name, hash, hint, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
		.bind(actor.slack_id, name, await keyHash(key), hint, Date.now())
		.first<{ id: number }>()
	return { id: row!.id, name, hint, key }
}

/** revokeKey deletes one of the visitor's own API keys, which stops working at once. */
export async function revokeKey(env: Env, actor: User, id: string): Promise<void> {
	need(actor, 2)
	const gone = /^\d{1,15}$/.test(id) ? await env.DB.prepare('DELETE FROM review_keys WHERE id = ? AND slack_id = ?').bind(Number(id), actor.slack_id).run() : null
	if (!gone?.meta.changes) throw new Refusal(404, 'No such key.')
}
