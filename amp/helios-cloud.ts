// helios-cloud: counts Amp threads that run in Amp's cloud toward your
// helios hours. Put it in your personal Amp plugins, and set HELIOS_SERVER
// (your helios site) and HELIOS_KEY (your sync key) in Amp's Secrets &
// Env Vars settings. It does nothing outside Amp's cloud, where the plugin
// that `helios setup` writes records threads instead.
import type { PluginAPI } from '@ampcode/plugin'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const description =
	'Counts time in Amp cloud threads toward your helios hours. Sends when you prompt and when Amp finishes, with its token and line counts and never the prompt text or code, to your helios site. Needs HELIOS_SERVER and HELIOS_KEY.'

const releases = 'https://github.com/part-avocado/helios/releases'
/** The first release whose `helios hook amp -relay` sends events to a site. */
const oldest = 'v0.5.2'
/** How often to look for a newer helios. */
const lookEvery = 3600_000
/** After a failed download, how long to wait before the next one. */
const retryAfter = 5 * 60_000
/** helios takes an event up to an hour late; older ones can't be placed in time. */
const tooLate = 50 * 60_000
/** How long Amp waits for helios on one event. */
const patience = 2000

const numbers = (tag: string) =>
	/^v(\d+)\.(\d+)\.(\d+)$/
		.exec(tag)
		?.slice(1)
		.map(Number)

/** Orders release tags, oldest first. */
function byVersion(a: string, b: string): number {
	const x = numbers(a) ?? [0, 0, 0]
	const y = numbers(b) ?? [0, 0, 0]
	return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!
}

async function get(url: string): Promise<Response> {
	const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
	if (!res.ok) throw new Error(`${url} answered ${res.status}`)
	return res
}

/** Asks where the "latest" link leads, which ends in the newest release's tag. */
async function latestTag(): Promise<string> {
	const res = await fetch(`${releases}/latest`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
	const tag = path.posix.basename(new URL(res.headers.get('location') ?? '', releases).pathname)
	if (!numbers(tag)) throw new Error('could not look up the latest helios release')
	return tag
}

/** Downloads release tag's helios for this machine to file, after checking it against the release's checksums. */
async function download(tag: string, file: string): Promise<void> {
	const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform as string]
	const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch as string]
	if (!os || !arch) throw new Error(`there is no helios for ${process.platform} ${process.arch}`)
	const asset = `helios_${os}_${arch}${os === 'windows' ? '.exe' : ''}`
	const base = `${releases}/download/${tag}`
	const sums = await (await get(`${base}/checksums.txt`)).text()
	const want = sums
		.split('\n')
		.map((line) => line.trim().split(/\s+/))
		.find((f) => f.length === 2 && f[1]!.replace(/^\*/, '') === asset)?.[0]
	if (!want) throw new Error(`${base}/checksums.txt has no entry for ${asset}`)
	const bytes = new Uint8Array(await (await get(`${base}/${asset}`)).arrayBuffer())
	if (createHash('sha256').update(bytes).digest('hex') !== want.toLowerCase()) {
		throw new Error(`${asset} does not match its checksum`)
	}
	// Written under another name first, so a half-written file is never run.
	const part = `${file}.part-${process.pid}`
	await writeFile(part, bytes, { mode: 0o755 })
	await rename(part, file)
}

/**
 * Returns the path of a helios that can relay: $HELIOS_BIN when set, else
 * the newest release, downloaded into dir and kept there. It looks for a
 * newer release once an hour.
 */
async function findHelios(dir: string): Promise<string> {
	if (process.env.HELIOS_BIN) return process.env.HELIOS_BIN
	await mkdir(dir, { recursive: true })
	const ext = process.platform === 'win32' ? '.exe' : ''
	const file = (tag: string) => path.join(dir, `helios-${tag}${ext}`)
	const have = (await readdir(dir))
		.map((name) => /^helios-(v\d+\.\d+\.\d+)(\.exe)?$/.exec(name)?.[1] ?? '')
		.filter((tag) => tag && byVersion(tag, oldest) >= 0)
		.sort(byVersion)
		.at(-1)
	const looked = path.join(dir, 'looked')
	const lookedAt = await stat(looked).then(
		(s) => s.mtimeMs,
		() => 0,
	)
	if (have && Date.now() - lookedAt < lookEvery) return file(have)
	try {
		const latest = await latestTag()
		if (byVersion(latest, oldest) < 0) throw new Error(`cloud threads need helios ${oldest} or later, and the latest release is ${latest}`)
		if (latest !== have) await download(latest, file(latest))
		await writeFile(looked, '')
		return file(latest)
	} catch (err) {
		if (have) return file(have) // the one already here still records
		throw err
	}
}

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

/**
 * The edits Amp's file tools made in one turn, for helios to count the
 * lines added and removed: each edit's old and new text, and the lines of
 * each patch. Only calls that finished count. The text goes no further than
 * helios on this machine, which keeps only the counts.
 */
function edits(amp: PluginAPI, messages: readonly unknown[] = []) {
	const out = { edits: [] as { old_string: string; new_string: string }[], lines_added: 0, lines_removed: 0 }
	const str = (v: unknown) => (typeof v === 'string' ? v : '')
	for (const { call, result } of amp.helpers.toolCallsInMessages(messages as Parameters<typeof amp.helpers.toolCallsInMessages>[0])) {
		if (result?.status !== 'done') continue
		const input = call.input ?? {}
		if (call.tool === 'edit_file') out.edits.push({ old_string: str(input.old_str), new_string: str(input.new_str) })
		else if (call.tool === 'create_file') out.edits.push({ old_string: '', new_string: str(input.content) })
		else if (call.tool === 'apply_patch') {
			for (const line of str(input.patch || input.input).split('\n')) {
				if (line.startsWith('+') && !line.startsWith('+++')) out.lines_added++
				else if (line.startsWith('-') && !line.startsWith('---')) out.lines_removed++
			}
		}
	}
	return out
}

export default function (amp: PluginAPI) {
	// On a person's own computer, the plugin `helios setup` writes records
	// threads in the local journal. This one is for Amp's cloud only.
	if (!process.env.AMP_ORB) return
	const server = process.env.HELIOS_SERVER
	const key = process.env.HELIOS_KEY
	if (!server || !key) {
		amp.logger.log('helios: not counting this cloud thread. Set HELIOS_SERVER and HELIOS_KEY in Secrets & Env Vars.')
		return
	}
	const root = amp.system.workspaceRoot ? amp.helpers.filePathFromURI(amp.system.workspaceRoot) : ''
	const env = { ...process.env, HELIOS_SERVER: server, HELIOS_KEY: key, HELIOS_DATA_DIR: path.join(amp.system.cacheDirectory, 'data') }

	let helios: Promise<string> | undefined
	let here = false // helios is on this machine, so handing it an event is quick
	let failedAt = 0
	let askedAt = 0
	const find = (): Promise<string | undefined> => {
		// Asked again each hour, so a thread that stays open gets a new release too.
		if ((!helios || Date.now() - askedAt > lookEvery) && Date.now() - failedAt > retryAfter) {
			askedAt = Date.now()
			const finding = findHelios(amp.system.cacheDirectory)
			helios = finding
			finding.then(
				() => (here = true),
				(err) => {
					amp.logger.log('helios: could not get helios, will try again:', String(err))
					if (helios === finding) helios = undefined
					failedAt = Date.now()
				},
			)
		}
		return helios ? helios.catch(() => undefined) : Promise.resolve(undefined)
	}

	// Hands one event to helios, which scores the prompt, keeps only the
	// counts, and sends them to the site. When a turn ends, helios v0.6.0 or
	// later also counts the person's cloud threads from what the site holds and
	// syncs the total, so no computer of theirs is needed. An older helios
	// only sends, and the site keeps the events until a newer one counts them.
	// Failures are ignored so Amp is never blocked.
	const hand = (bin: string, event: object) =>
		new Promise<void>((resolve) => {
			try {
				const child = spawn(bin, ['hook', 'amp', '-relay'], { stdio: ['pipe', 'ignore', 'ignore'], env, windowsHide: true })
				const timer = setTimeout(resolve, patience)
				const done = () => (clearTimeout(timer), resolve())
				child.on('error', () => {
					// The cache was cleared; fetch helios again.
					amp.logger.log('helios: could not run', bin)
					helios = undefined
					here = false
					done()
				})
				child.on('close', done)
				child.stdin.on('error', () => {})
				child.stdin.end(JSON.stringify(event))
			} catch {
				resolve()
			}
		})

	// Events wait here, in memory only, while helios downloads: a fresh orb
	// has none. Each carries its own time, so waiting doesn't move it.
	type Used = Partial<ReturnType<typeof tokens> & ReturnType<typeof edits>>
	let waiting: ({ session_id: string; cwd: string; hook_event_name: string; prompt: string; time: string } & Used)[] = []
	let sending = Promise.resolve()
	const record = (event: string, threadID: string, prompt = '', used: Used = {}) => {
		waiting.push({ session_id: threadID, cwd: root, hook_event_name: event, prompt, time: new Date().toISOString(), ...used })
		sending = sending.then(async () => {
			const bin = await find()
			waiting = waiting.filter((w) => Date.now() - Date.parse(w.time) < tooLate).slice(-500)
			if (!bin) return
			while (waiting.length) {
				await hand(bin, waiting[0]!)
				waiting.shift()
			}
		})
		// Waiting for the hand-off means a reload or shutdown can't cut it off.
		// A download is not waited for: it would hold up the person's prompt.
		if (!here) return Promise.resolve()
		return Promise.race([sending, new Promise<void>((resolve) => setTimeout(resolve, patience))])
	}

	find() // start the download before the first prompt
	amp.on('session.start', (e) => record('session.start', e.thread.id))
	amp.on('agent.start', async (e) => {
		await record('agent.start', e.thread.id, e.message)
		return {}
	})
	// A turn that was stopped ends here too, with the tokens it used and the edits it made until then.
	// helios also sends the commits in the thread's repository when a turn ends.
	amp.on('agent.end', (e) => record('agent.end', e.thread.id, '', { ...tokens(e.messages), ...edits(amp, e.messages) }))
}
