// Small helpers shared by the request handlers.

/** Refusal is an answer to a request the Worker won't carry out. */
export class Refusal extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly headers: Record<string, string> = {},
	) {
		super(message)
	}
}

export function json(value: unknown, status = 200): Response {
	return jsonText(JSON.stringify(value), status)
}

/** jsonText answers with text that is already JSON. */
export function jsonText(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

export function redirect(to: string, cookies: string[] = []): Response {
	const headers = new Headers({ Location: to, 'Cache-Control': 'no-store' })
	for (const c of cookies) headers.append('Set-Cookie', c)
	return new Response(null, { status: 302, headers })
}

export function cookie(request: Request, name: string): string {
	for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
		const [k, ...v] = part.trim().split('=')
		if (k === name) return v.join('=')
	}
	return ''
}

/** setCookie makes a cookie that scripts can't read and other sites can't send with a POST. */
export function setCookie(request: Request, name: string, value: string, maxAgeSeconds: number): string {
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
	return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`
}

export function toBase64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** fromBase64Url returns null for text that isn't base64url. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
	try {
		return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
	} catch {
		return null
	}
}

export function randomToken(bytes: number): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/**
 * readText reads a request body of at most max bytes, and refuses a larger
 * one without holding all of it in memory.
 */
export async function readText(request: Request, max: number): Promise<string> {
	const limit = max >= 1 << 20 ? `${max >> 20} MB` : `${max >> 10} KB`
	const tooLarge = new Refusal(413, `That is larger than the ${limit} this server accepts.`)
	if (Number(request.headers.get('Content-Length') ?? 0) > max) throw tooLarge
	if (!request.body) return ''
	const decoder = new TextDecoder()
	let text = ''
	let size = 0
	for await (const chunk of request.body) {
		size += chunk.byteLength
		if (size > max) throw tooLarge
		text += decoder.decode(chunk, { stream: true })
	}
	return text + decoder.decode()
}
