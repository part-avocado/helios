// Shared by the pages that need an account: the dashboard and settings.
const $ = (id) => document.getElementById(id)

// showBan puts a ban on this account at the top of the page. A ban lasts
// until a reviewer lifts it. The person is not told why: the reason is for reviewers.
function showBan(ban) {
	$('ban-banner').hidden = !ban
	if (!ban) return
	$('ban-text').textContent = t('ban.text')
}
const esc = (s) => String(s).replace(/[&<>\"']/g, (c) => `&#${c.charCodeAt(0)};`)
const dur = (sec) => {
	const m = Math.round(sec / 60)
	return m < 60 ? t('common.minutesShort', { m }) : t('common.hoursShort', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') })
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
	const time = s.today && s.today.witnessed_seconds ? dur(s.today.witnessed_seconds) : ''
	if (!s.working) return time ? t('live.todayOnly', { time }) : ''
	const where = withProject && s.working.project ? t('live.in', { project: esc(s.working.project.split('/').pop()) }) : ''
	const today = time ? t('live.witnessed', { time }) : ''
	return `<span class="dot live"></span><span>${t('live.working', { where, tool: esc(s.working.tool), today })}</span>`
}

// ago says how long before now a time was, such as "3 minutes ago".
function ago(ms) {
	const fmt = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' })
	const seconds = (ms - Date.now()) / 1000
	for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
		if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit)
	}
	return t('common.justNow')
}

// api calls this site's API as the signed-in visitor. It throws the server's
// own message when the server refuses, and sends a visitor whose sign-in has
// run out to sign in again.
async function api(path, init) {
	const res = await fetch(path, { cache: 'no-store', ...init })
	if (res.status === 401) {
		location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)
		throw new Error(t('api.signingIn'))
	}
	if (!res.ok) throw new Error((await res.text()).trim() || t('api.serverAnswered', { status: res.status }))
	return res.json()
}

// renderSetup fills el with the steps that connect a computer to this
// account. key is the visitor's sync key, shown only for the Amp cloud
// secret: a computer gets it by `teardrop login`, so no command holds it.
function renderSetup(el, key) {
	const sh = 'curl -fsSL https://raw.githubusercontent.com/part-avocado/teardrop/main/install.sh | sh'
	const ps = 'irm https://raw.githubusercontent.com/part-avocado/teardrop/main/install.ps1 | iex'
	const connect = `teardrop login -server ${location.origin}`
	const cmd = (text, kind = '') => `<div class="cmd ${kind}"><code>${esc(text)}</code><button class="copy" type="button">${t('common.copy')}</button></div>`
	// What to paste into an agent so it does the setup itself. The questions
	// teardrop setup asks are answered up front, since an agent can't answer them.
	const prompt = t('setup.agentPrompt', { sh, ps, connect })
	// What to paste into Amp so its cloud threads count. The sync key is left
	// out: Amp asks for a secret's value in a private dialog.
	const cloudPrompt = t('setup.cloudPrompt', { origin: location.origin })
	el.innerHTML = `<ol class="steps">
		<li><div>
			<h3>${t('setup.install.h')}</h3>
			<p>${t('setup.install.p')}</p>
			<div class="cmdbox" data-tabs>
				<div class="tabs" role="tablist">
					<button type="button" data-tab="mac" role="tab">${t('os.mac')}</button>
					<button type="button" data-tab="linux" role="tab">${t('os.linux')}</button>
					<button type="button" data-tab="windows" role="tab">${t('os.windows')}</button>
				</div>
				<div class="tab-panel" data-tab="mac">${cmd(sh)}</div>
				<div class="tab-panel" data-tab="linux">${cmd(sh)}</div>
				<div class="tab-panel" data-tab="windows">${cmd(ps, 'ps')}</div>
			</div>
		</div></li>
		<li><div>
			<h3>${t('setup.connect.h')}</h3>
			<p>${t('setup.connect.p')}</p>
			<div class="cmdbox">${cmd(connect)}</div>
			<p class="fine">${t('setup.connect.fine')}</p>
		</div></li>
		<li><div>
			<h3>${t('setup.tools.h')}</h3>
			<p>${t('setup.tools.p')}</p>
			<div class="cmdbox tools" data-tabs data-default="claude">
				<div class="tabs" role="tablist">
					<button type="button" data-tab="claude" role="tab">Claude Code</button>
					<button type="button" data-tab="codex" role="tab">Codex</button>
					<button type="button" data-tab="amp" role="tab">Amp</button>
				</div>
				<div class="tab-panel" data-tab="claude"><p>${t('setup.tools.claude')}</p></div>
				<div class="tab-panel" data-tab="codex"><p>${t('setup.tools.codex')}</p></div>
				<div class="tab-panel" data-tab="amp"><p>${t('setup.tools.amp1')}</p>${cmd('teardrop setup amp')}<p>${t('setup.tools.amp2')}</p>
					<h4>${t('setup.cloud.h')}</h4>
					<p>${t('setup.cloud.p1')}</p>
					<div class="prompt"><code>${esc(cloudPrompt)}</code><button class="copy" type="button">${t('common.copy')}</button></div>
					<p>${t('setup.cloud.p2')}</p>${cmd(key, 'plain')}
					<p>${t('setup.cloud.p3')}</p></div>
			</div>
		</div></li>
		<li class="alt"><div>
			<h3>${t('setup.agent.h')}</h3>
			<p>${t('setup.agent.p')}</p>
			<div class="prompt"><code>${esc(prompt)}</code><button class="copy" type="button">${t('common.copy')}</button></div>
			<p class="fine">${t('setup.agent.fine')}</p>
		</div></li>
	</ol>`
	initTabs(el)
}
