// teardrop: records Amp activity in teardrop's local time-tracking journal.
// Written by `teardrop setup`. Rerun it to update this file, and run
// `teardrop setup -remove-hooks` to remove it.
import type { PluginAPI } from '@ampcode/plugin'
import { spawn } from 'node:child_process'

export const description =
	'Records when you send a prompt and when Amp finishes, with its token counts and without the prompt text, in the local teardrop time-tracking journal.'

const teardrop = __TEARDROP_PATH__

/**
 * Adds up the tokens the model read and wrote in one turn, from the usage Amp
 * records with each reply. Cached tokens count as read, as they do for the
 * other tools. Replies without usage add nothing.
 */
function tokens(messages: readonly unknown[] = []) {
	type Usage = { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number | null; cacheReadInputTokens?: number | null }
	let tokens_in = 0
	let tokens_out = 0
	for (const m of messages as { role?: string; usage?: Usage }[]) {
		if (m?.role !== 'assistant' || !m.usage) continue
		tokens_in += (m.usage.inputTokens ?? 0) + (m.usage.cacheCreationInputTokens ?? 0) + (m.usage.cacheReadInputTokens ?? 0)
		tokens_out += m.usage.outputTokens ?? 0
	}
	return { tokens_in, tokens_out }
}

export default function (amp: PluginAPI) {
	// Without an open workspace the project is unknown; the plugin's own cwd would be misleading.
	const root = amp.system.workspaceRoot ? amp.helpers.filePathFromURI(amp.system.workspaceRoot) : ''

	// Hand the event to teardrop, which scores the prompt and keeps only the
	// counts. Waiting for it (about 15 ms) means a reload or shutdown can't cut
	// off the write; failures are ignored so Amp is never blocked.
	const record = (event: string, threadID: string, prompt = '', more: object = {}) =>
		new Promise<void>((resolve) => {
			try {
				const child = spawn(teardrop, ['hook', 'amp'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
				const timer = setTimeout(resolve, 2000)
				const done = () => (clearTimeout(timer), resolve())
				child.on('error', done) // teardrop was moved or uninstalled
				child.on('close', done)
				child.stdin.on('error', () => {})
				child.stdin.end(JSON.stringify({ session_id: threadID, cwd: root, hook_event_name: event, prompt, ...more }))
			} catch {
				resolve()
			}
		})

	amp.on('session.start', (e) => record('session.start', e.thread.id))
	amp.on('agent.start', async (e) => {
		await record('agent.start', e.thread.id, e.message)
		return {}
	})
	// A turn that was stopped ends here too, with the tokens it used until then.
	amp.on('agent.end', (e) => record('agent.end', e.thread.id, '', tokens(e.messages)))
}
