// teardrop: records OpenCode activity in teardrop's local time-tracking journal.
// Written by `teardrop setup`. Rerun it to update this file, and run
// `teardrop setup -remove-hooks opencode` to remove it. OpenCode 2 runs
// setup; OpenCode 1 runs server.
import { spawn } from 'node:child_process'

const teardrop = __TEARDROP_PATH__
// Words that go before teardrop's own: none, unless it runs through a script.
const before: string[] = __TEARDROP_ARGS__

// Hand the event to teardrop, which scores the prompt and keeps only the
// counts. Failures are ignored so OpenCode is never blocked.
const record = (event: string, sessionID: string, cwd: string, prompt = '') =>
	new Promise<void>((resolve) => {
		try {
			const child = spawn(teardrop, [...before, 'hook', 'opencode', '-event', event], { cwd: cwd || undefined, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
			const timer = setTimeout(resolve, 2000)
			const done = () => (clearTimeout(timer), resolve())
			child.on('error', done) // teardrop was moved or uninstalled
			child.on('close', done)
			child.stdin.on('error', () => {})
			child.stdin.end(JSON.stringify({ session_id: sessionID, cwd, prompt }))
		} catch {
			resolve()
		}
	})

// What a turn's end is called in OpenCode's event stream.
const ends = ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'] as const

type Session = { parentID?: string; location?: { directory?: string } }
type Context = {
	location: { directory: string }
	session: {
		get(input: { sessionID: string }): Promise<Session>
		hook(name: 'prompt', fn: (event: { sessionID: string; prompt: { text?: string } }) => unknown): Promise<unknown>
	}
	event: { subscribe(options: { types: readonly string[]; signal: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string } }> }
}

// Plugin.define from @opencode/plugin returns its argument, so a plain
// definition loads without that package.
export default {
	id: 'teardrop',
	setup(ctx: Context) {
		// A subagent's session has a parent; its prompts come from the agent, not a person.
		const session = async (sessionID: string) => {
			const s = await ctx.session.get({ sessionID }).catch(() => undefined)
			return { sub: Boolean(s?.parentID), cwd: s?.location?.directory ?? ctx.location.directory }
		}

		// The prompt hook sees what a person sends, before OpenCode admits it.
		// It leaves the prompt as it is.
		void ctx.session.hook('prompt', async (e) => {
			const s = await session(e.sessionID)
			if (!s.sub) await record('prompt', e.sessionID, s.cwd, e.prompt.text ?? '')
		})

		const stop = new AbortController()
		void (async () => {
			try {
				for await (const e of ctx.event.subscribe({ types: ends, signal: stop.signal })) {
					const id = e.data?.sessionID
					if (!id) continue
					const s = await session(id)
					if (!s.sub) await record('turn_end', id, s.cwd)
				}
			} catch {
				// The stream ends when the plugin unloads.
			}
		})()
		return () => stop.abort()
	},

	// OpenCode 1 reads only this; OpenCode 2 reads only id and setup.
	async server(input: V1Input) {
		const session = async (id: string) => {
			const s = (await input.client.session.get({ path: { id } }).catch(() => undefined))?.data
			return { sub: Boolean(s?.parentID), cwd: s?.directory ?? input.directory }
		}
		return {
			// Each message a person sends; the parts OpenCode adds itself are synthetic.
			'chat.message': async (i: { sessionID: string }, o: { parts: { type: string; text?: string; synthetic?: boolean }[] }) => {
				const text = o.parts.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text ?? '').join('\n')
				const s = await session(i.sessionID)
				if (text && !s.sub) await record('prompt', i.sessionID, s.cwd, text)
			},
			// A session goes idle when its turn ends, whether it finished, failed, or was stopped.
			event: async ({ event }: { event: { type: string; properties?: { sessionID?: string } } }) => {
				const id = event.properties?.sessionID
				if (event.type !== 'session.idle' || !id) return
				const s = await session(id)
				if (!s.sub) await record('turn_end', id, s.cwd)
			},
		}
	},
}

type V1Input = {
	directory: string
	client: { session: { get(o: { path: { id: string } }): Promise<{ data?: { parentID?: string; directory?: string } }> } }
}
