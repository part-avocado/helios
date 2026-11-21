// Shared by the pages that need an account: the dashboard, settings, and people.
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>\"']/g, (c) => `&#${c.charCodeAt(0)};`)
const dur = (sec) => {
	const m = Math.round(sec / 60)
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
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

// renderSetup fills el with the two steps that connect a computer to this
// account. key is the visitor's sync key.
function renderSetup(el, key) {
	const sh = 'curl -fsSL https://raw.githubusercontent.com/part-avocado/teardrop/main/install.sh | sh'
	const ps = 'irm https://raw.githubusercontent.com/part-avocado/teardrop/main/install.ps1 | iex'
	const cmd = (text, kind = '') => `<div class="cmd ${kind}"><code>${esc(text)}</code><button class="copy" type="button">Copy</button></div>`
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
			<p>Open a new terminal and run this once. It uploads your hours, and teardrop keeps them up to date while you work in Claude Code or Amp.</p>
			<div class="cmdbox">${cmd(`teardrop sync -server ${location.origin} -key ${key}`)}</div>
			<p class="fine">The command includes your sync key, which can only upload your stats. Keep it to yourself.</p>
		</div></li>
	</ol>`
	initTabs(el)
}
