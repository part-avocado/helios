// The helios connector: a remote MCP server, at /mcp, that chat apps add as
// a connector. Claude on the web (claude.ai), the Claude apps, ChatGPT, and
// any other MCP client sign in with OAuth and then record time the way a
// harness's hooks do: a prompt record when Claude starts a reply, and a turn
// end when it finishes. The site stamps each record with the time it arrives,
// so a chat's time is witnessed like any other. The model chooses to call
// the tools, so the records carry the app's own tool name ("claude-ai",
// "chatgpt", ...) and reviewers can weigh them apart from coding tools.
//
// OAuth, for connectors (RFC 8414, 9728, 7591, and PKCE):
//
//	GET  /.well-known/oauth-protected-resource   which server signs in for /mcp
//	GET  /.well-known/oauth-authorization-server where to sign in and trade codes
//	POST /oauth/register   a client registers its redirect URIs; its client_id holds them, signed
//	GET  /oauth/authorize  the person sees what it will do and chooses Allow
//	POST /oauth/token      the code becomes a sync key named after the app, revoked under Settings
import { createSyncKey, derived, keyHash, keyUser, sessionUser, type User, userByID } from './auth.ts'
import { fromBase64Url, json, readText, redirect, Refusal, randomToken, toBase64Url } from './http.ts'
import { promptDays } from './records.ts'
import { type Ask, back, esc, page, readAsk } from './signin.ts'
import { banMessage } from './staff.ts'

/** The MCP version this server speaks, and the older ones it also answers. */
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
/** How long a client has to trade a code. */
const CODE_LIFETIME = 5 * 60_000
/** The largest MCP request taken. */
const MAX_BODY = 64 << 10

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
	'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}

/** A registered client, as its client_id carries it. */
interface Client {
	/** What it calls itself. */
	name: string
	/** The redirect URIs it registered. */
	redirects: string[]
	/** The tool name its records carry. */
	tool: string
}

/**
 * toolFor names the records of a client by what it calls itself: the chat
 * apps people know get their own name, and others "mcp-" and theirs.
 */
export function toolFor(name: string): string {
	const n = name.toLowerCase()
	if (n.includes('claude')) return 'claude-ai'
	if (n.includes('chatgpt') || n.includes('openai')) return 'chatgpt'
	if (n.includes('gemini')) return 'gemini'
	if (n.includes('copilot')) return 'copilot-chat'
	if (n.includes('le chat') || n.includes('mistral')) return 'le-chat'
	const slug = n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 27)
	return 'mcp-' + (slug || 'client')
}

async function clientKey(env: Env): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', await derived(env, 'mcp client ids'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** clientID writes a client into an ID only this server can make, so registering stores nothing. */
async function clientID(env: Env, c: Client): Promise<string> {
	const body = toBase64Url(new TextEncoder().encode(JSON.stringify({ n: c.name, r: c.redirects, t: c.tool })))
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await clientKey(env), new TextEncoder().encode(body)))
	return `tdmcp_${body}.${toBase64Url(sig)}`
}

/** readClient returns the client a client_id names, or null for one this server didn't make. */
export async function readClient(env: Env, id: string): Promise<Client | null> {
	const m = /^tdmcp_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(id)
	const sig = m && fromBase64Url(m[2]!)
	if (!m || !sig || !(await crypto.subtle.verify('HMAC', await clientKey(env), sig, new TextEncoder().encode(m[1]!)))) return null
	try {
		const c = JSON.parse(new TextDecoder().decode(fromBase64Url(m[1]!)!))
		return { name: String(c.n), redirects: (c.r as unknown[]).map(String), tool: String(c.t) }
	} catch {
		return null
	}
}

/** oauthError is an OAuth error answer, which clients read as JSON. */
const oauthError = (status: number, error: string, description: string) => json({ error, error_description: description }, status)

/** metadata answers the two .well-known documents a connector reads first. */
export function metadata(url: URL, which: 'resource' | 'server'): Response {
	const res =
		which === 'resource'
			? json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], bearer_methods_supported: ['header'], resource_name: 'helios' })
			: json({
					issuer: url.origin,
					authorization_endpoint: `${url.origin}/oauth/authorize`,
					token_endpoint: `${url.origin}/oauth/token`,
					registration_endpoint: `${url.origin}/oauth/register`,
					response_types_supported: ['code'],
					grant_types_supported: ['authorization_code'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['none'],
					scopes_supported: ['helios'],
				})
	for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v)
	return res
}

/** register answers POST /oauth/register: a client says its name and redirect URIs, and gets a client_id. */
export async function register(request: Request, env: Env): Promise<Response> {
	let body: { client_name?: unknown; redirect_uris?: unknown }
	try {
		body = JSON.parse(await readText(request, 16 << 10)) ?? {}
	} catch {
		return oauthError(400, 'invalid_client_metadata', 'Send the client metadata as JSON.')
	}
	const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
	if (!redirects.length || redirects.length > 10) return oauthError(400, 'invalid_redirect_uri', 'Register one to ten redirect_uris.')
	for (const r of redirects) {
		try {
			readAsk(new URLSearchParams({ redirect_uri: r }))
		} catch (e) {
			return oauthError(400, 'invalid_redirect_uri', e instanceof Refusal ? e.message : 'A redirect_uri is not valid.')
		}
	}
	const name = String(body.client_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || new URL(redirects[0]!).host
	const client: Client = { name, redirects, tool: toolFor(name) }
	const res = json(
		{ client_id: await clientID(env, client), client_name: name, redirect_uris: redirects, grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now() / 1000) },
		201,
	)
	res.headers.set('Access-Control-Allow-Origin', '*')
	return res
}

/** authorizeConnector answers GET and POST /oauth/authorize. */
export async function authorizeConnector(request: Request, env: Env, url: URL): Promise<Response> {
	let params = url.searchParams
	if (request.method === 'POST') {
		if (new URL(request.headers.get('Origin') ?? 'null', url).origin !== url.origin) throw new Refusal(403, 'That request did not come from this site.')
		params = new URLSearchParams(await readText(request, 16 << 10))
	}
	const client = await readClient(env, params.get('client_id') ?? '')
	if (!client) return page(400, 'Can’t connect', `<p class="muted">The app that sent you here isn’t registered with this site. Remove the connector and add it again.</p>`)
	let ask: Ask
	try {
		ask = readAsk(params)
		if (!client.redirects.includes(ask.redirect_uri)) throw new Refusal(400, 'The app asked to send you back to an address it didn’t register.')
		if (!ask.challenge) throw new Refusal(400, 'The app sent no code_challenge. Connectors must use PKCE.')
		if ((params.get('response_type') ?? 'code') !== 'code') throw new Refusal(400, 'The app asked for a response_type other than code.')
	} catch (e) {
		if (!(e instanceof Refusal)) throw e
		return page(e.status, 'Can’t connect', `<p class="muted">${esc(e.message)}</p>`)
	}
	const user = await sessionUser(request, env)
	if (!user) {
		const again = new URLSearchParams([...params].filter(([k]) => k !== 'decision'))
		return redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${again}`)}`)
	}
	if (user.ban) return page(403, 'This account is banned', `<p class="muted">A banned account can’t connect apps.</p>`)
	if (request.method === 'GET') return allowPage(ask, client, params.get('client_id')!, user)
	if (params.get('decision') !== 'allow') return redirect(back(ask, { error: 'access_denied' }))
	const code = 'tdm_' + randomToken(24)
	const now = Date.now()
	await env.DB.batch([
		env.DB.prepare('DELETE FROM sign_in_codes WHERE expires_at < ?').bind(now - 86400_000),
		env.DB.prepare('INSERT INTO sign_in_codes (hash, user_id, site, name, redirect_uri, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
			await keyHash(code),
			user.id,
			ask.redirect.origin,
			client.name,
			ask.redirect_uri,
			ask.challenge,
			now,
			now + CODE_LIFETIME,
		),
	])
	return redirect(back(ask, { code }))
}

function allowPage(ask: Ask, client: Client, id: string, user: User): Response {
	const hidden = Object.entries({
		client_id: id,
		redirect_uri: ask.redirect_uri,
		state: ask.state,
		code_challenge: ask.challenge,
		code_challenge_method: 'S256',
		response_type: 'code',
	})
		.map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
		.join('')
	return page(200, `Connect ${client.name}`, `
		<p class="muted"><b class="site">${esc(client.name)}</b> (${esc(ask.redirect.origin)}) would like to add time to your helios hours.</p>
		<ul class="grants">
			<li>Record when a chat starts and finishes a reply, counted as <code>${esc(client.tool)}</code></li>
			<li>Read your hours and projects, to answer your questions about them</li>
		</ul>
		<p class="fine muted">It never sends your messages or Claude’s replies, only times and word counts. It gets a sync key named “${esc(client.name)} connector”: revoke it under Settings, then Setup, to disconnect it.</p>
		<form method="post" action="/oauth/authorize">${hidden}
			<button class="btn primary" name="decision" value="allow">Allow</button>
			<button class="btn" name="decision" value="deny">Cancel</button>
		</form>
		<p class="fine muted">Signed in as <b>${esc(user.name || user.slack_id)}</b>.</p>`)
}

/**
 * token answers POST /oauth/token: a code from /oauth/authorize, with its
 * redirect_uri, client_id, and PKCE verifier, becomes a sync key. A code
 * works once; tried again, the key it became is revoked.
 */
export async function token(request: Request, env: Env): Promise<Response> {
	const text = await readText(request, 16 << 10)
	let body: Record<string, string>
	try {
		body = text.trimStart().startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text))
	} catch {
		return oauthError(400, 'invalid_request', 'Send the token request as a form.')
	}
	if ((body.grant_type ?? '') !== 'authorization_code') return oauthError(400, 'unsupported_grant_type', 'Only authorization_code is supported.')
	const client = await readClient(env, String(body.client_id ?? ''))
	if (!client) return oauthError(401, 'invalid_client', 'That client_id was not made by this site. Register again.')
	const code = String(body.code ?? '')
	const bad = oauthError(400, 'invalid_grant', 'That code is not valid. It may have expired or been used already.')
	if (!/^tdm_[A-Za-z0-9_-]+$/.test(code)) return bad
	const hash = await keyHash(code)
	const row = await env.DB.prepare('SELECT user_id, name, redirect_uri, challenge, expires_at, used_at, key_id FROM sign_in_codes WHERE hash = ?')
		.bind(hash)
		.first<{ user_id: number; name: string; redirect_uri: string; challenge: string; expires_at: number; used_at: number | null; key_id: number | null }>()
	if (!row) return bad
	if (row.used_at != null) {
		if (row.key_id != null) await env.DB.prepare('DELETE FROM sync_keys WHERE id = ?').bind(row.key_id).run()
		return bad
	}
	if (Date.now() > row.expires_at || row.name !== client.name || String(body.redirect_uri ?? '') !== row.redirect_uri) return bad
	const verifier = new TextEncoder().encode(String(body.code_verifier ?? ''))
	if (toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', verifier))) !== row.challenge) return oauthError(400, 'invalid_grant', 'code_verifier does not match the code_challenge.')
	const taken = await env.DB.prepare('UPDATE sign_in_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL').bind(Date.now(), hash).run()
	if (!taken.meta.changes) return bad
	const user = await userByID(env, row.user_id)
	if (!user) return bad
	if (user.ban) return oauthError(403, 'access_denied', 'This account is banned.')
	const made = await createSyncKey(env, user, `${client.name} connector`)
	await env.DB.prepare('UPDATE sign_in_codes SET key_id = ? WHERE hash = ?').bind(made.id, hash).run()
	return new Response(JSON.stringify({ access_token: made.key, token_type: 'Bearer', scope: 'helios' }), {
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
	})
}

// The MCP server itself: Streamable HTTP, answering each JSON-RPC request
// with JSON. It keeps no state between requests beyond the session ID it
// hands out, which names a chat when the client doesn't.

const INSTRUCTIONS = `helios counts the time a person spends working with AI. In every conversation, call helios_log with phase "start" before you begin each reply, and with phase "end" just before you give your final answer, passing the same conversation value each time. Never include the person's message or your reply. If the work belongs to a code repository, pass it as project, such as github.com/owner/name. Use helios_stats when the person asks how much time they have spent.`

const TOOLS = [
	{
		name: 'helios_log',
		title: 'Log chat time',
		description:
			'Records that a reply started or finished in this conversation, so the time counts toward the person’s helios hours. Call with phase "start" before each reply and "end" before the final answer. Sends only the time, a conversation name, an optional project, and a word count, never message text.',
		inputSchema: {
			type: 'object',
			properties: {
				phase: { type: 'string', enum: ['start', 'end'], description: '"start" when you begin a reply, "end" when you finish it.' },
				conversation: { type: 'string', maxLength: 120, description: 'A short name for this conversation that you keep the same for every call in it, such as a slug of its topic.' },
				project: { type: 'string', maxLength: 300, description: 'Optional: the repository the work is for, such as github.com/owner/name.' },
				prompt_words: { type: 'integer', minimum: 0, description: 'On "start": how many words the person’s message has.' },
			},
			required: ['phase', 'conversation'],
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},
	{
		name: 'helios_stats',
		title: 'Read helios hours',
		description: 'Returns the person’s engaged hours from helios: in total, per day, and per project, over the last days (7 by default).',
		inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 366, description: 'How many days back, 7 by default.' } } },
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
]

type RPC = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** mcp answers /mcp. */
export async function mcp(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
	const user = await keyUser(request, env)
	if (!user) {
		return new Response('Connect this app to helios first.\n', {
			status: 401,
			headers: { ...CORS, 'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"` },
		})
	}
	if (user.ban) throw new Refusal(403, banMessage())
	// This server sends nothing unasked, so there is no stream to open, and no session to end.
	if (request.method === 'GET') return new Response('This server answers POST only.\n', { status: 405, headers: { ...CORS, Allow: 'POST' } })
	if (request.method === 'DELETE') return new Response(null, { status: 204, headers: CORS })
	if (request.method !== 'POST') return new Response('Not allowed\n', { status: 405, headers: CORS })

	let body: RPC | RPC[]
	try {
		body = JSON.parse(await readText(request, MAX_BODY))
	} catch {
		return rpcReply([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }], false)
	}
	const batch = Array.isArray(body)
	const calls = (batch ? body : [body]) as RPC[]
	let session = request.headers.get('Mcp-Session-Id') ?? ''
	const newSession = calls.some((c) => c?.method === 'initialize')
	if (newSession) session = randomToken(16)
	const client = await clientOf(env, request, user)
	const out: unknown[] = []
	for (const c of calls) {
		// Notifications, such as notifications/initialized, get no answer.
		if (!c || typeof c !== 'object' || c.id === undefined) continue
		try {
			out.push({ jsonrpc: '2.0', id: c.id, result: await answer(env, user, client, session, c) })
		} catch (e) {
			const message = e instanceof Refusal ? e.message : 'Something went wrong on the server.'
			if (!(e instanceof Refusal)) console.error(JSON.stringify({ message: 'mcp call failed', method: c.method, error: String(e) }))
			out.push({ jsonrpc: '2.0', id: c.id, error: { code: e instanceof RPCError ? e.code : -32603, message } })
		}
	}
	if (!out.length) return new Response(null, { status: 202, headers: CORS })
	const res = rpcReply(out, batch)
	if (newSession) res.headers.set('Mcp-Session-Id', session)
	return res
}

/** A JSON-RPC error, with its code. */
class RPCError extends Refusal {
	code: number
	constructor(code: number, message: string) {
		super(400, message)
		this.code = code
	}
}

function rpcReply(out: unknown[], batch: boolean): Response {
	return new Response(JSON.stringify(batch ? out : out[0]), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

/**
 * clientOf names the app a sync key was made for, from the key's name, which
 * /oauth/token sets to "<app> connector". A key made by hand is "mcp-client".
 */
async function clientOf(env: Env, request: Request, user: User): Promise<{ tool: string }> {
	const key = /^Bearer (tdk_[A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? ''
	const row = await env.DB.prepare('SELECT name FROM sync_keys WHERE hash = ? AND user_id = ?').bind(await keyHash(key), user.id).first<{ name: string }>()
	const name = row?.name.replace(/ connector$/, '') ?? ''
	return { tool: name ? toolFor(name) : 'mcp-client' }
}

async function answer(env: Env, user: User, client: { tool: string }, session: string, c: RPC): Promise<unknown> {
	switch (c.method) {
		case 'initialize': {
			const asked = String(c.params?.protocolVersion ?? '')
			return {
				protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'helios', title: 'helios', version: '1.0.0' },
				instructions: INSTRUCTIONS,
			}
		}
		case 'ping':
			return {}
		case 'tools/list':
			return { tools: TOOLS }
		case 'tools/call': {
			const args = (c.params?.arguments ?? {}) as Record<string, unknown>
			if (c.params?.name === 'helios_log') return logTurn(env, user, client.tool, session, args)
			if (c.params?.name === 'helios_stats') return readStats(env, user, args)
			throw new RPCError(-32602, `There is no tool named ${String(c.params?.name)}.`)
		}
	}
	throw new RPCError(-32601, `This server does not answer ${String(c.method)}.`)
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

/** projectKey turns what the model calls the project into a record's project key: a repository, or the app's chats. */
export function projectKey(given: unknown, tool: string): string {
	const s = String(given ?? '')
		.trim()
		.replace(/^[a-z]+:\/\//i, '')
		.replace(/^git@([^:]+):/, '$1/')
		.replace(/\.git$/, '')
		.replace(/\/+$/, '')
		.toLowerCase()
	return /^[a-z0-9.-]+\.[a-z]{2,}(\/[a-z0-9._-]+){2}$/.test(s) ? s : `chat:${tool}`
}

/** logTurn records one reply's start or end, timed by this server's clock. */
async function logTurn(env: Env, user: User, tool: string, session: string, args: Record<string, unknown>) {
	const phase = args.phase
	if (phase !== 'start' && phase !== 'end') return text('phase must be "start" or "end".', true)
	const conversation = String(args.conversation ?? '').trim().slice(0, 120)
	const id = conversation || session
	if (!id) return text('Pass a conversation name, and the same one each time.', true)
	// A conversation's name is the model's own, so it is kept only as a digest.
	const digest = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${tool}\n${id}`)))).slice(0, 22)
	const words = Math.max(0, Math.min(100_000, Math.floor(Number(args.prompt_words) || 0)))
	const line = JSON.stringify({
		t: new Date().toISOString(),
		tool,
		session: `mcp:${digest}`,
		event: phase === 'start' ? 'prompt' : 'turn_end',
		human: phase === 'start',
		project: projectKey(args.project, tool),
		...(phase === 'start' && words ? { judged: words, real: words } : {}),
	})
	const hub = env.HUB.get(env.HUB.idFromName(String(user.id)))
	const { stored, limited } = await hub.add(user.id, 'cloud', 0, [line], null)
	if (limited) return text(`helios is not taking more records right now: ${limited.message}`, true)
	return text(stored ? `Logged the ${phase} of this reply.` : 'Already logged.')
}

/** readStats sums the person's days for the model to answer with. */
async function readStats(env: Env, user: User, args: Record<string, unknown>) {
	const days = Math.max(1, Math.min(366, Math.floor(Number(args.days) || 7)))
	const since = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10)
	// The hub writes what it holds first, so the answer is up to the moment.
	await env.HUB.get(env.HUB.idFromName(String(user.id))).flush()
	const rows = await promptDays(env, user.id, since)
	const hours = (s: number) => Math.round((s / 3600) * 10) / 10
	const projects = new Map<string, number>()
	let total = 0
	for (const d of rows) {
		total += d.witnessed_seconds + d.unwitnessed_seconds
		for (const [p, v] of Object.entries(d.projects)) projects.set(p, (projects.get(p) ?? 0) + (v[0] ?? 0) + (v[1] ?? 0))
	}
	const summary = {
		since,
		engaged_hours: hours(total),
		days: rows.map((d) => ({ day: d.day, hours: hours(d.witnessed_seconds + d.unwitnessed_seconds), prompts: d.prompts })),
		projects: [...projects].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([name, s]) => ({ name, hours: hours(s) })),
	}
	return { ...text(JSON.stringify(summary)), structuredContent: summary }
}
