// Public profiles, at /@handle: what anyone can read about a person without
// signing in. A profile shows the handle, never the name or Slack ID, and
// names a project only when it is a public repository or its owner chose to
// show it. Folders on a person's computer are never shown.
import { type User, userByHandle } from './auth.ts'
import { json, Refusal } from './http.ts'
import { projectCommits } from './git.ts'
import { repo } from './public.ts'
import { personEngaged, personProjects, personTotals } from './reports.ts'

/** A handle: 3 to 30 lowercase letters, digits, and hyphens, starting and ending with a letter or digit. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/

/** visibleOwner returns whose profile /@handle is, or null when no one may see it. */
export async function visibleOwner(env: Env, handle: string): Promise<User | null> {
	if (!HANDLE.test(handle.toLowerCase())) return null
	const user = await userByHandle(env, handle)
	// A private or banned account looks the same as one that doesn't exist.
	return user && user.profile_public && !user.ban ? user : null
}

/** A person's choices for one project: whether their profile names it, and the repositories linked to it. Either may be unset. */
interface Choice {
	shown?: boolean
	repos?: string[]
}

/** projectChoices returns a person's choices for their projects, by project key. */
async function projectChoices(env: Env, userID: number): Promise<Map<string, Choice>> {
	const { results } = await env.DB.prepare('SELECT project_key, shown, repos FROM project_settings WHERE user_id = ?').bind(userID).all<{ project_key: string; shown: number; repos: string | null }>()
	return new Map(results.map((r) => [r.project_key, { shown: r.shown === 1, ...(r.repos != null ? { repos: JSON.parse(r.repos) as string[] } : {}) }]))
}

/** isShown says whether a profile names a project: by its owner's choice, or else when it is a public repository. */
const isShown = (key: string, choices: Map<string, Choice>) => choices.get(key)?.shown ?? repo(key) !== null

/** reposOf is the repositories linked to a project: its owner's list, or else the one its key names. */
export const reposOf = (key: string, choices: Map<string, Choice>): string[] => choices.get(key)?.repos ?? (repo(key) ? [repo(key)!] : [])

/** How many repositories one project may link. */
const MAX_REPOS = 10

/**
 * githubRepo reads a GitHub repository as typed: github.com/owner/name, a
 * https:// or git@ address of one, or owner/name. It returns
 * github.com/owner/name, or null when it is none of those.
 */
export function githubRepo(text: string): string | null {
	const m = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com[/:]|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([\w.-]{1,100}?)(?:\.git)?\/?$/.exec(text.trim())
	if (!m || m[2] === '.' || m[2] === '..') return null
	return `github.com/${m[1]}/${m[2]}`
}

/** profileJSON answers GET /api/public/v1/users/{handle}. */
export async function profileJSON(env: Env, handle: string): Promise<Response> {
	const user = await visibleOwner(env, handle)
	if (!user) throw new Refusal(404, 'No such profile.')
	// The totals are read once, for the projects, the days, and the total.
	const [{ projects, days, engaged_seconds }, choices, git] = await Promise.all([personTotals(env, user.id), projectChoices(env, user.id), projectCommits(env, user.id)])
	const perDay: Record<string, number> = {}
	for (const computer of days) for (const [date, s] of Object.entries(computer)) perDay[date] = (perDay[date] ?? 0) + s
	const named = projects.filter((p) => isShown(p.key, choices))
	const unnamed = projects.filter((p) => !isShown(p.key, choices))
	const res = json({
		handle: user.handle,
		joined: new Date(user.created_at).toISOString().slice(0, 7),
		// As in their own total: time on two projects at once counts once.
		engaged_seconds,
		days: Object.keys(perDay).sort().map((date) => ({ date, engaged_seconds: perDay[date] })),
		projects: named.map((p) => {
			const repos = reposOf(p.key, choices)
			// Commits come from the repository the project's key names, so they are
			// listed, newest first, only while that is still its first repository.
			const g = repo(p.key) && repos[0] === repo(p.key) ? git.get(p.key) : undefined
			return { name: p.name, repo: repos[0] ?? null, repos, engaged_seconds: p.engaged_seconds, ...(g ? { checked: g.checked, commits: g.commits.slice(0, 5).map((c) => ({ sha: c.sha, t: c.t, found: c.found ?? null })) } : {}) }
		}),
		other_projects: { count: unnamed.length, engaged_seconds: unnamed.reduce((sum, p) => sum + p.engaged_seconds, 0) },
	})
	res.headers.set('Cache-Control', 'public, max-age=60')
	return res
}

/** escapeXML makes text safe inside SVG text and attributes. */
const escapeXML = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

/** hoursText is a badge's figure: minutes under an hour, then whole hours. */
const hoursText = (seconds: number) => {
	const h = Math.round(seconds / 3600)
	return seconds < 3600 ? `${Math.round(seconds / 60)} min` : h === 1 ? '1 hour' : `${h.toLocaleString('en-US')} hours`
}

/**
 * profileBadge answers GET /api/public/v1/users/{handle}/badge.svg: a badge
 * for a README with the hours the public profile shows, in all or, with
 * `project`, in one project it names, given by repository or name. It shows
 * nothing the profile doesn't: a private profile or a project it doesn't
 * name is "not found".
 */
export async function profileBadge(env: Env, handle: string, project: string | null): Promise<Response> {
	const user = await visibleOwner(env, handle)
	if (!user) throw new Refusal(404, 'No such profile.')
	let label = 'teardrop', seconds: number
	if (project) {
		const [projects, choices] = await Promise.all([personProjects(env, user.id), projectChoices(env, user.id)])
		const asked = githubRepo(project)?.toLowerCase()
		const p = projects.find((x) => isShown(x.key, choices) && (repo(x.key) === project || x.name === project || reposOf(x.key, choices).some((r) => r.toLowerCase() === asked)))
		if (!p) throw new Refusal(404, 'That profile names no such project.')
		label = `teardrop: ${p.name}`
		seconds = p.engaged_seconds
	} else {
		seconds = await personEngaged(env, user.id)
	}
	const value = hoursText(seconds)
	// Widths as for 11px Verdana, near enough: about 7 pixels a character.
	const w = (s: string) => Math.round(s.length * 7 + 12)
	const lw = w(label), vw = w(value)
	const [l, v] = [escapeXML(label), escapeXML(value)]
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${l}: ${v}"><title>${l}: ${v}</title>
<clipPath id="r"><rect width="${lw + vw}" height="20" rx="3"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="#2f81f7"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${l}</text><text x="${lw + vw / 2}" y="14">${v}</text></g>
</svg>`
	return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } })
}

/** ownProfile is what the owner sees of their profile in Settings: every project, and whether it is named. */
export async function ownProfile(env: Env, user: User) {
	return { handle: user.handle, public: user.profile_public, projects: await ownProjects(env, user) }
}

/** ownProjects is each of the owner's projects, with whether their profile shows it and the repositories linked to it. */
export async function ownProjects(env: Env, user: User) {
	const [projects, choices] = await Promise.all([personProjects(env, user.id), projectChoices(env, user.id)])
	return projects.map((p) => ({ key: p.key, name: p.name, repo: reposOf(p.key, choices)[0] ?? null, repos: reposOf(p.key, choices), engaged_seconds: p.engaged_seconds, shown: isShown(p.key, choices) }))
}

/**
 * updateProject changes one of the owner's projects: whether their profile
 * shows it (public), and the GitHub repositories linked to it (repos, an
 * array that replaces the list). Each field is optional.
 */
export async function updateProject(env: Env, user: User, body: Record<string, unknown>): Promise<void> {
	const key = body.key
	if (typeof key !== 'string') throw new Refusal(400, 'Say which project with its key.')
	if (!(await personProjects(env, user.id)).some((p) => p.key === key)) throw new Refusal(404, 'No such project.')
	const choices = await projectChoices(env, user.id)
	let shown = isShown(key, choices)
	let repos: string[] | null = choices.get(key)?.repos ?? null
	if (body.public !== undefined) {
		if (typeof body.public !== 'boolean') throw new Refusal(400, 'Say whether the project is public with true or false.')
		shown = body.public
	}
	if (body.repos !== undefined) {
		if (!Array.isArray(body.repos)) throw new Refusal(400, 'Send repos as a list, such as ["github.com/you/site"].')
		const seen = new Set<string>()
		repos = []
		for (const r of body.repos) {
			const one = typeof r === 'string' ? githubRepo(r) : null
			if (!one) throw new Refusal(400, `${String(r).slice(0, 80)} is not a GitHub repository. Write it as github.com/owner/name.`)
			if (seen.has(one.toLowerCase())) continue
			seen.add(one.toLowerCase())
			repos.push(one)
		}
		if (repos.length > MAX_REPOS) throw new Refusal(400, `A project links up to ${MAX_REPOS} repositories.`)
	}
	await env.DB.prepare(
		'INSERT INTO project_settings (user_id, project_key, shown, repos) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (user_id, project_key) DO UPDATE SET shown = ?3, repos = ?4',
	)
		.bind(user.id, key, Number(shown), repos && JSON.stringify(repos))
		.run()
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
	const hidden = body.public === false
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
	// A profile made private stops showing visitors who have it open whether its owner is at work.
	if (hidden) await env.HUB.get(env.HUB.idFromName(String(user.id))).closePublic()
}
