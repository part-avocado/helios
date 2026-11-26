// Per-prompt records: what every harness sends, through `teardrop hook <tool>`,
// for each prompt and turn end as it happens. The account's UserHub keeps them
// (hub.ts) and the site works out the hours from them, crediting only time it
// saw arrive. Reading back: day totals from D1's prompt_days.
import type { User } from './auth.ts'
import { Refusal } from './http.ts'

/** The computer a batch comes from, as the client names it in a header; '' for one that doesn't. */
const computerOf = (request: Request) => /^td-[0-9a-f]{12}$|^cloud$/.exec(request.headers.get('X-Teardrop-Computer') ?? '')?.[0] ?? 'cloud'

/**
 * relayRecords hands a batch of records to the account's hub and returns how
 * many were new, and how many it refused as dated in the future. The
 * client's UTC offset, in minutes, decides its calendar days.
 */
export async function relayRecords(env: Env, user: User, request: Request, body: string): Promise<{ stored: number; future: number }> {
	// Real offsets run from -12:00 to +14:00. A batch without one (a cloud machine's) doesn't move the calendar.
	const header = request.headers.get('X-Teardrop-UTC-Offset')
	const offset = header == null || header === '' || Number.isNaN(Number(header)) ? null : Math.max(-720, Math.min(840, Math.round(Number(header))))
	const hub = env.HUB.get(env.HUB.idFromName(String(user.id)))
	// How far the computer's clock runs behind this one, from when it says it sent the batch.
	const sentAt = Date.parse(request.headers.get('X-Teardrop-Sent-At') ?? '')
	const reading = Number.isNaN(sentAt) ? null : Date.now() - sentAt
	const { stored, future, limited } = await hub.add(user.id, computerOf(request), offset, body.split('\n'), reading)
	// The client keeps the batch on a 429 and sends it again later.
	if (limited) throw new Refusal(429, limited.message, { 'Retry-After': String(limited.retryAfter) })
	return { stored, future }
}

export interface PromptDay {
	day: string
	witnessed_seconds: number
	unwitnessed_seconds: number
	prompts: number
	tokens_in: number
	tokens_out: number
	projects: Record<string, [number, number, number]>
}

/** promptDays returns a person's day totals from their records, oldest first: time on two computers at once counts once. */
export async function promptDays(env: Env, userID: number, since = ''): Promise<PromptDay[]> {
	const { results } = await env.DB.prepare(
		`SELECT day, witnessed_seconds, unwitnessed_seconds, prompts, tokens_in, tokens_out, projects FROM prompt_days
		 WHERE user_id = ? AND computer_id = '' AND day >= ? ORDER BY day`,
	)
		.bind(userID, since)
		.all<Omit<PromptDay, 'projects'> & { projects: string }>()
	return results.map((r) => ({ ...r, projects: JSON.parse(r.projects) }))
}
