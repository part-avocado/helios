// teardrop-cloud: counts Amp threads that run in Amp's cloud toward your
// teardrop hours. Put it in your personal Amp plugins, and set TEARDROP_SERVER
// (your teardrop site) and TEARDROP_KEY (your sync key) in Amp's Secrets &
// Env Vars settings. It does nothing outside Amp's cloud, where the plugin
// that `teardrop setup` writes records threads instead.
import type { PluginAPI } from '@ampcode/plugin'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const description =
	'Counts time in Amp cloud threads toward your teardrop hours. Sends when you prompt and when Amp finishes, never the prompt text, to your teardrop site. Needs TEARDROP_SERVER and TEARDROP_KEY.'

const releases = 'https://github.com/part-avocado/teardrop/releases'
/** The first release whose `teardrop hook amp -relay` sends events to a site. */
const oldest = 'v0.5.2'
/** How often to look for a newer teardrop. */
const lookEvery = 24 * 3600_000
/** After a failed download, how long to wait before the next one. */
const retryAfter = 5 * 60_000
/** teardrop takes an event up to an hour late; older ones can't be placed in time. */
const tooLate = 50 * 60_000
/** How long Amp waits for teardrop on one event. */
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
	if (!numbers(tag)) throw new Error('could not look up the latest teardrop release')
	return tag
}

/** Downloads release tag's teardrop for this machine to file, after checking it against the release's checksums. */
async function download(tag: string, file: string): Promise<void> {
	const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform as string]
	const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch as string]
	if (!os || !arch) throw new Error(`there is no teardrop for ${process.platform} ${process.arch}`)
	const asset = `teardrop_${os}_${arch}${os === 'windows' ? '.exe' : ''}`
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
 * Returns the path of a teardrop that can relay: $TEARDROP_BIN when set, else
 * the newest release, downloaded into dir and kept there. It looks for a
 * newer release once a day.
 */
async function findTeardrop(dir: string): Promise<string> {
	if (process.env.TEARDROP_BIN) return process.env.TEARDROP_BIN
	await mkdir(dir, { recursive: true })
	const ext = process.platform === 'win32' ? '.exe' : ''
	const file = (tag: string) => path.join(dir, `teardrop-${tag}${ext}`)
	const have = (await readdir(dir))
		.map((name) => /^teardrop-(v\d+\.\d+\.\d+)(\.exe)?$/.exec(name)?.[1] ?? '')
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
		if (byVersion(latest, oldest) < 0) throw new Error(`cloud threads need teardrop ${oldest} or later, and the latest release is ${latest}`)
		if (latest !== have) await download(latest, file(latest))
		await writeFile(looked, '')
		return file(latest)
	} catch (err) {
		if (have) return file(have) // the one already here still records
		throw err
	}
}

export default function (amp: PluginAPI) {
	// On a person's own computer, the plugin `teardrop setup` writes records
	// threads in the local journal. This one is for Amp's cloud only.
	if (!process.env.AMP_ORB) return
	const server = process.env.TEARDROP_SERVER
	const key = process.env.TEARDROP_KEY
	if (!server || !key) {
		amp.logger.log('teardrop: not counting this cloud thread. Set TEARDROP_SERVER and TEARDROP_KEY in Secrets & Env Vars.')
		return
	}
	const root = amp.system.workspaceRoot ? amp.helpers.filePathFromURI(amp.system.workspaceRoot) : ''
	const env = { ...process.env, TEARDROP_SERVER: server, TEARDROP_KEY: key, TEARDROP_DATA_DIR: path.join(amp.system.cacheDirectory, 'data') }

	let teardrop: Promise<string> | undefined
	let here = false // teardrop is on this machine, so handing it an event is quick
	let failedAt = 0
	const find = (): Promise<string | undefined> => {
		if (!teardrop && Date.now() - failedAt > retryAfter) {
			const finding = findTeardrop(amp.system.cacheDirectory)
			teardrop = finding
			finding.then(
				() => (here = true),
				(err) => {
					amp.logger.log('teardrop: could not get teardrop, will try again:', String(err))
					if (teardrop === finding) teardrop = undefined
					failedAt = Date.now()
				},
			)
		}
		return teardrop ? teardrop.catch(() => undefined) : Promise.resolve(undefined)
	}

	// Hands one event to teardrop, which scores the prompt, keeps only the
	// counts, and sends them to the site. Failures are ignored so Amp is never
	// blocked.
	const hand = (bin: string, event: object) =>
		new Promise<void>((resolve) => {
			try {
				const child = spawn(bin, ['hook', 'amp', '-relay'], { stdio: ['pipe', 'ignore', 'ignore'], env, windowsHide: true })
				const timer = setTimeout(resolve, patience)
				const done = () => (clearTimeout(timer), resolve())
				child.on('error', () => {
					// The cache was cleared; fetch teardrop again.
					amp.logger.log('teardrop: could not run', bin)
					teardrop = undefined
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

	// Events wait here, in memory only, while teardrop downloads: a fresh orb
	// has none. Each carries its own time, so waiting doesn't move it.
	let waiting: { session_id: string; cwd: string; hook_event_name: string; prompt: string; time: string }[] = []
	let sending = Promise.resolve()
	const record = (event: string, threadID: string, prompt = '') => {
		waiting.push({ session_id: threadID, cwd: root, hook_event_name: event, prompt, time: new Date().toISOString() })
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
	amp.on('agent.end', (e) => record('agent.end', e.thread.id))
}
