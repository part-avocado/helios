// Commits. A person's computer sends a `commit` record for each of their
// commits in a project with a remote (sha, author time, lines added and
// removed; never the message or code). The hub folds them into project_git,
// and an hourly cron asks GitHub which claimed commits exist. A commit's time
// is set by its author; the time the site first saw it is not.
// This file uses nothing from the Workers runtime, so tests can import it.

/** What this file needs of the Worker's Env, so it type-checks without the Workers types. */
interface Statement {
	bind(...values: unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> }
}
export interface GitEnv {
	DB: { prepare(sql: string): Statement }
	GITHUB_TOKEN?: string
	GITHUB_API?: string
}

export interface Commit {
	sha: string
	t: number
	added: number
	removed: number
	seen: number
	found?: boolean
}

/** How many commits a project's row keeps. */
const RECENT = 50
/** How often a project is checked again. */
const EVERY = 3600_000
/** How many projects one run checks, and how much of GitHub's hourly allowance it leaves alone. */
const BATCH = 40
const RESERVE = 200

/** remember merges new commits into a project's row. */
export async function remember(env: GitEnv, userID: number, project: string, commits: Commit[]): Promise<void> {
	const row = await env.DB.prepare('SELECT recent, claimed FROM project_git WHERE user_id = ? AND project_key = ?').bind(userID, project).first<{ recent: string; claimed: number }>()
	const have = new Map((JSON.parse(row?.recent ?? '[]') as Commit[]).map((c) => [c.sha, c]))
	let added = 0
	for (const c of commits) {
		if (have.has(c.sha)) continue
		have.set(c.sha, c)
		added++
	}
	if (!added) return
	const recent = [...have.values()].sort((a, b) => b.t - a.t).slice(0, RECENT)
	await env.DB.prepare(
		`INSERT INTO project_git (user_id, project_key, claimed, recent) VALUES (?1, ?2, ?3, ?4)
		 ON CONFLICT (user_id, project_key) DO UPDATE SET claimed = claimed + ?3, recent = ?4, checked_at = NULL`,
	)
		.bind(userID, project, added, JSON.stringify(recent))
		.run()
}

/** repoOf returns owner/repo for a github.com project key, else null. */
const repoOf = (key: string) => /^github\.com\/([\w.-]+\/[\w.-]+)$/.exec(key)?.[1] ?? null

/**
 * checkGit asks GitHub which unchecked commits exist, for projects not
 * checked in the last hour. Without GITHUB_TOKEN it does nothing. It stops
 * when GitHub's remaining allowance runs low. It returns how many projects it checked.
 */
export async function checkGit(env: GitEnv, get: typeof fetch = fetch, now = Date.now()): Promise<number> {
	if (!env.GITHUB_TOKEN) return 0
	const api = (env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '')
	const { results } = await env.DB.prepare(
		`SELECT user_id, project_key, recent FROM project_git WHERE project_key LIKE 'github.com/%' AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at NULLS FIRST LIMIT ${BATCH}`,
	)
		.bind(now - EVERY)
		.all<{ user_id: number; project_key: string; recent: string }>()
	let checked = 0
	const ask = async (path: string) => {
		const res = await get(api + path, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'teardrop' } })
		const left = Number(res.headers.get('X-RateLimit-Remaining') ?? RESERVE + 1)
		return { status: res.status, low: left <= RESERVE }
	}
	for (const row of results) {
		const repo = repoOf(row.project_key)
		const recent = JSON.parse(row.recent) as Commit[]
		if (repo) {
			// A repository GitHub won't show (private, or gone) leaves its commits unchecked.
			const r = await ask(`/repos/${repo}`)
			if (r.status === 200) {
				for (const c of recent.filter((c) => c.found === undefined)) {
					const q = await ask(`/repos/${repo}/commits/${c.sha}`)
					if (q.status === 200) c.found = true
					else if (q.status === 404 || q.status === 422) c.found = false
					if (q.low) break
				}
			}
			if (r.low) break
		}
		await env.DB.prepare('UPDATE project_git SET checked_at = ?, recent = ?, found = ? WHERE user_id = ? AND project_key = ?')
			.bind(now, JSON.stringify(recent), recent.filter((c) => c.found).length, row.user_id, row.project_key)
			.run()
		checked++
	}
	return checked
}

/** projectCommits returns a person's commits per project key, for their profile and dashboard. */
export async function projectCommits(env: GitEnv, userID: number): Promise<Map<string, { checked: boolean; commits: Commit[] }>> {
	const { results } = await env.DB.prepare('SELECT project_key, checked_at, recent FROM project_git WHERE user_id = ?').bind(userID).all<{ project_key: string; checked_at: number | null; recent: string }>()
	return new Map(results.map((r) => [r.project_key, { checked: r.checked_at != null, commits: JSON.parse(r.recent) as Commit[] }]))
}
