// Public profiles, at /@handle: what anyone can read about a person without
// signing in. A profile shows the handle, never the name or Slack ID, and
// names a project only when it is a public repository or its owner chose to
// show it. Folders on a person's computer are never shown.
import { type User, userByHandle } from './auth.ts'
import { json, Refusal } from './http.ts'
import { repo } from './public.ts'
import { computers, personDays, personProjects } from './reports.ts'

/** A handle: 3 to 30 lowercase letters, digits, and hyphens, starting and ending with a letter or digit. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/

/** visibleOwner returns whose profile /@handle is, or null when no one may see it. */
export async function visibleOwner(env: Env, handle: string): Promise<User | null> {
	if (!HANDLE.test(handle.toLowerCase())) return null
	const user = await userByHandle(env, handle)
	// A private or banned account looks the same as one that doesn't exist.
	return user && user.profile_public && !user.ban ? user : null
}

/** shownProjects returns a person's choices of which projects their profile names, by project key. */
async function shownProjects(env: Env, userID: number): Promise<Map<string, boolean>> {
	const { results } = await env.DB.prepare('SELECT project_key, shown FROM project_settings WHERE user_id = ?').bind(userID).all<{ project_key: string; shown: number }>()
	return new Map(results.map((r) => [r.project_key, r.shown === 1]))
}

/** isShown says whether a profile names a project: by its owner's choice, or else when it is a public repository. */
const isShown = (key: string, choices: Map<string, boolean>) => choices.get(key) ?? repo(key) !== null

/** profileJSON answers GET /api/public/v1/users/{handle}. */
export async function profileJSON(env: Env, handle: string): Promise<Response> {
	const user = await visibleOwner(env, handle)
	if (!user) throw new Refusal(404, 'No such profile.')
	const [projects, days, choices, theirs] = await Promise.all([personProjects(env, user.id), personDays(env, user.id), shownProjects(env, user.id), computers(env, user.id)])
	const perDay: Record<string, number> = {}
	for (const computer of days) for (const [date, s] of Object.entries(computer)) perDay[date] = (perDay[date] ?? 0) + s
	const named = projects.filter((p) => isShown(p.key, choices))
	const unnamed = projects.filter((p) => !isShown(p.key, choices))
	const res = json({
		handle: user.handle,
		joined: new Date(user.created_at).toISOString().slice(0, 7),
		// As in their own total: time on two projects at once counts once.
		engaged_seconds: theirs.reduce((sum, c) => sum + c.engaged_seconds, 0),
		days: Object.keys(perDay).sort().map((date) => ({ date, engaged_seconds: perDay[date] })),
		projects: named.map((p) => ({ name: p.name, repo: repo(p.key), engaged_seconds: p.engaged_seconds })),
		other_projects: { count: unnamed.length, engaged_seconds: unnamed.reduce((sum, p) => sum + p.engaged_seconds, 0) },
	})
	res.headers.set('Cache-Control', 'public, max-age=60')
	return res
}

/** ownProfile is what the owner sees of their profile in Settings: every project, and whether it is named. */
export async function ownProfile(env: Env, user: User) {
	const [projects, choices] = await Promise.all([personProjects(env, user.id), shownProjects(env, user.id)])
	return {
		handle: user.handle,
		public: user.profile_public,
		projects: projects.map((p) => ({ key: p.key, name: p.name, repo: repo(p.key), engaged_seconds: p.engaged_seconds, shown: isShown(p.key, choices) })),
	}
}

/**
 * updateProfile changes the owner's handle, whether the profile is public,
 * and which projects it names. Each field is optional.
 */
export async function updateProfile(env: Env, user: User, body: Record<string, unknown>): Promise<void> {
	const changes: D1PreparedStatement[] = []
	if (body.handle !== undefined) {
		const handle = String(body.handle).trim().toLowerCase()
		if (!HANDLE.test(handle)) throw new Refusal(400, 'A handle is 3 to 30 letters, digits, and hyphens, and starts and ends with a letter or digit.')
		const taken = await env.DB.prepare('SELECT 1 FROM users WHERE handle = ? AND id != ?').bind(handle, user.id).first()
		if (taken) throw new Refusal(409, 'That handle is taken. Try another.')
		changes.push(env.DB.prepare('UPDATE users SET handle = ? WHERE id = ?').bind(handle, user.id))
	}
	if (body.public !== undefined) {
		if (typeof body.public !== 'boolean') throw new Refusal(400, 'Say whether the profile is public with true or false.')
		changes.push(env.DB.prepare('UPDATE users SET profile_public = ? WHERE id = ?').bind(Number(body.public), user.id))
	}
	if (body.projects !== undefined) {
		const projects = body.projects
		if (!projects || typeof projects !== 'object' || Array.isArray(projects)) throw new Refusal(400, 'Send projects as an object of project keys to true or false.')
		// Only their own projects, so the table holds no more rows than they have projects.
		const theirs = new Set((await personProjects(env, user.id)).map((p) => p.key))
		for (const [key, shown] of Object.entries(projects)) {
			if (typeof shown !== 'boolean') throw new Refusal(400, 'Send projects as an object of project keys to true or false.')
			if (!theirs.has(key)) throw new Refusal(404, 'No such project.')
			changes.push(
				env.DB.prepare('INSERT INTO project_settings (user_id, project_key, shown) VALUES (?1, ?2, ?3) ON CONFLICT (user_id, project_key) DO UPDATE SET shown = ?3').bind(user.id, key, Number(shown)),
			)
		}
	}
	if (!changes.length) return
	try {
		await env.DB.batch(changes)
	} catch (e) {
		// Someone else took the handle since the check above.
		if (/UNIQUE/.test(String(e))) throw new Refusal(409, 'That handle is taken. Try another.')
		throw e
	}
}
