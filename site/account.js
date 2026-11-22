// Shared by the pages that need an account: the dashboard and settings.
const $ = (id) => document.getElementById(id)

// showBan puts a ban on this account at the top of the page. A ban lasts
// until a reviewer lifts it. The person is not told why: the reason is for reviewers.
function showBan(ban) {
	$('ban-banner').hidden = !ban
	if (!ban) return
	$('ban-text').textContent = `It is banned until a reviewer lifts the ban. Nothing new is taken from it: no syncs, uploads, cloud events, or submissions. What was synced before stays here for you to see.`
}
const esc = (s) => String(s).replace(/[&<>\"']/g, (c) => `&#${c.charCodeAt(0)};`)
const dur = (sec) => {
	const m = Math.round(sec / 60)
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// liveFeed follows a person's live state: whether they are at it now, and
// today's witnessed time. It holds a WebSocket open to wsPath, which the site
// pushes to as each prompt or turn end arrives, and without one asks path
// every 30 seconds while the tab is visible. onState gets each state.
function liveFeed(path, wsPath, onState) {
	let socket = null, timer = 0, retry = 1000
	const ask = async () => {
		clearTimeout(timer)
		if (!socket && document.visibilityState === 'visible') {
			try {
				const res = await fetch(path, { cache: 'no-store' })
				if (res.ok) onState(await res.json())
			} catch {}
		}
		timer = setTimeout(ask, 30000)
	}
	const open = () => {
		let ws
		try {
			ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${wsPath}`)
		} catch {
			return ask()
		}
		ws.onopen = () => { socket = ws; retry = 1000 }
		ws.onmessage = (e) => { try { onState(JSON.parse(e.data)) } catch {} }
		ws.onclose = () => {
			socket = null
			ask()
			setTimeout(open, retry = Math.min(retry * 2, 60000))
		}
	}
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState !== 'visible') return
		if (socket) socket.send('state')
		else ask()
	})
	open()
	ask()
}

// liveText says what a live state shows, as HTML.
function liveText(s, withProject) {
	const today = s.today && s.today.witnessed_seconds ? ` - ${dur(s.today.witnessed_seconds)} witnessed today` : ''
	if (!s.working) return today ? `Today: ${today.slice(3)}` : ''
	const where = withProject && s.working.project ? ` in <b>${esc(s.working.project.split('/').pop())}</b>` : ''
	return `<span class="dot live"></span>Working now${where} with ${esc(s.working.tool)}${today}`
}

// ago says how long before now a time was, such as "3 minutes ago".
function ago(ms) {
	const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
	const seconds = (ms - Date.now()) / 1000
	for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
		if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit)
	}
	return 'just now'
}

// api calls this site's API as the signed-in visitor. It throws the server's
// own message when the server refuses, and sends a visitor whose sign-in has
// run out to sign in again.
async function api(path, init) {
	const res = await fetch(path, { cache: 'no-store', ...init })
	if (res.status === 401) {
		location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)
		throw new Error('Signing you in again…')
	}
	if (!res.ok) throw new Error((await res.text()).trim() || `The server answered ${res.status}.`)
	return res.json()
}

// renderSetup fills el with the steps that connect a computer to this
// account. key is the visitor's sync key.
function renderSetup(el, key) {
	const sh = 'curl -fsSL https://raw.githubusercontent.com/part-avocado/teardrop/main/install.sh | sh'
	const ps = 'irm https://raw.githubusercontent.com/part-avocado/teardrop/main/install.ps1 | iex'
	const connect = `teardrop sync -server ${location.origin} -key ${key}`
	const cmd = (text, kind = '') => `<div class="cmd ${kind}"><code>${esc(text)}</code><button class="copy" type="button">Copy</button></div>`
	// What to paste into an agent so it does the setup itself. The questions
	// teardrop setup asks are answered up front, since an agent can't answer them.
	const prompt = [
		'Set up teardrop on this computer and connect it to my account.',
		'',
		`1. Install it: run \`${sh}\` (on Windows, in PowerShell: \`${ps}\`). Set TEARDROP_NO_SETUP=1 first so the installer does not stop to ask questions.`,
		'2. Run `teardrop setup -yes`. It adds the Claude Code hooks and the Amp plugin for the tools I have.',
		`3. Run \`${connect}\`.`,
		'4. Run `teardrop` and show me its output.',
		'',
		'Do not repeat the sync key in your replies. If you are Amp, tell me to run "plugins: reload" in my open threads.',
	].join('\n')
	// What to paste into Amp so its cloud threads count. The sync key is left
	// out: Amp asks for a secret's value in a private dialog.
	const cloudPrompt = [
		'Count my Amp cloud threads with teardrop.',
		'',
		'1. Save https://raw.githubusercontent.com/part-avocado/teardrop/main/amp/teardrop-cloud.ts as teardrop-cloud.ts in my personal Amp plugins, and push it.',
		`2. Add a personal environment variable named TEARDROP_SERVER with the value ${location.origin}`,
		'3. Add a personal secret named TEARDROP_KEY. Ask me for its value; I will paste it myself.',
		'',
		'Tell me when it is done.',
	].join('\n')
	el.innerHTML = `<ol class="steps">
		<li><div>
			<h3>Install teardrop</h3>
			<p>Paste this into a terminal on the computer you code on. If teardrop is already there, this updates it.</p>
			<div class="cmdbox" data-tabs>
				<div class="tabs" role="tablist">
					<button type="button" data-tab="mac" role="tab">macOS</button>
					<button type="button" data-tab="linux" role="tab">Linux</button>
					<button type="button" data-tab="windows" role="tab">Windows</button>
				</div>
				<div class="tab-panel" data-tab="mac">${cmd(sh)}</div>
				<div class="tab-panel" data-tab="linux">${cmd(sh)}</div>
				<div class="tab-panel" data-tab="windows">${cmd(ps, 'ps')}</div>
			</div>
		</div></li>
		<li><div>
			<h3>Connect it to your account</h3>
			<p>Open a new terminal and run this once. It uploads your hours, and teardrop syncs again each time a reply finishes in Claude Code or Amp, or you stop one.</p>
			<div class="cmdbox">${cmd(connect)}</div>
			<p class="fine">The command includes your sync key, which can only upload your stats. Keep it to yourself.</p>
		</div></li>
		<li><div>
			<h3>Check your tools</h3>
			<p><code>teardrop setup</code> already looked for these. Run it again any time to add one you installed later.</p>
			<div class="cmdbox tools" data-tabs data-default="claude">
				<div class="tabs" role="tablist">
					<button type="button" data-tab="claude" role="tab">Claude Code</button>
					<button type="button" data-tab="codex" role="tab">Codex</button>
					<button type="button" data-tab="amp" role="tab">Amp</button>
				</div>
				<div class="tab-panel" data-tab="claude"><p>Setup adds hooks to Claude Code's settings, so each prompt is recorded as you send it. Your past sessions are read from its logs, so they count too. Nothing else to do.</p></div>
				<div class="tab-panel" data-tab="codex"><p>teardrop reads Codex's session logs, so there is nothing to install. Use Codex as usual; your sessions show up after the next sync.</p></div>
				<div class="tab-panel" data-tab="amp"><p>Amp keeps threads on its own servers, so setup writes a small plugin to <code>~/.config/amp/plugins/teardrop.ts</code>. It records when you send a prompt and when Amp finishes, never the prompt text. To add only the plugin:</p>${cmd('teardrop setup amp')}<p>New Amp threads load the plugin on their own. In a thread that is already open, run <b>plugins: reload</b> from the command palette.</p>
					<h4>Threads in Amp's cloud</h4>
					<p>Threads you start in the Amp app or on ampcode.com run on Amp's machines, where that plugin can't reach. To count them too, paste this into any Amp thread:</p>
					<div class="prompt"><code>${esc(cloudPrompt)}</code><button class="copy" type="button">Copy</button></div>
					<p>When Amp asks for the secret, paste your sync key:</p>${cmd(key, 'plain')}
					<p>Cloud time is counted in the cloud and reaches your dashboard when Amp finishes a turn or you stop it. No computer needs to be on.</p></div>
			</div>
		</div></li>
		<li><div>
			<h3>Or let your agent do it</h3>
			<p>Paste this into Amp or Claude Code and it runs the steps above for you. It answers setup's questions in advance, since an agent can't.</p>
			<div class="prompt"><code>${esc(prompt)}</code><button class="copy" type="button">Copy</button></div>
			<p class="fine">This prompt includes your sync key, so it ends up in that thread's history. Make a new key under Settings if you'd rather not leave it there.</p>
		</div></li>
	</ol>`
	initTabs(el)
}
