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
// every 30 seconds while the tab is visible. onState gets each state. The
// site says nothing when work stops, so "working now" is dropped here, 5
// minutes after the record it came from, the longest one record keeps it up.
const LIVE_FOR = 5 * 60000
function liveFeed(path, wsPath, report) {
	let socket = null, timer = 0, retry = 1000, stale = 0
	const onState = (s) => {
		clearTimeout(stale)
		// By this clock: for half a minute at least and 5 minutes at most, should it and the record's clock disagree.
		if (s && s.working) stale = setTimeout(() => report({ ...s, working: null }), Math.min(LIVE_FOR, Math.max(30000, s.working.since + LIVE_FOR - Date.now())))
		report(s)
	}
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

const INSTALL = 'https://raw.githubusercontent.com/part-avocado/helios/main/install'
// The name of the sync key made for cloud sessions.
const CLOUD_KEY = 'Cloud sessions'
// setupCommands are the one line to paste on each OS: install (or update),
// then connect to this site. install.ps1 puts helios on this session's
// PATH; install.sh only on a new terminal's, so its own path is named.
function setupCommands() {
	return {
		sh: `curl -fsSL ${INSTALL}.sh | sh && ~/.local/bin/helios login -server ${location.origin}`,
		ps: `irm ${INSTALL}.ps1 | iex; helios login -server ${location.origin}`,
	}
}

// A command, or a prompt, in a box with a Copy button.
const cmd = (text, kind = '') => `<div class="cmd ${kind}"><code>${esc(text)}</code><button class="copy" type="button">${t('common.copy')}</button></div>`
const promptBox = (text) => `<div class="prompt"><code>${esc(text)}</code><button class="copy" type="button">${t('common.copy')}</button></div>`

// renderCloudSetup fills el with the three steps that count Amp's cloud
// threads, which need no computer: make a sync key, named "Cloud sessions"
// (CLOUD_KEY; it was "Amp cloud" once) and shown once; paste a prompt into
// Amp, which adds the plugin and this site's address; and paste the key when
// Amp asks for it. The key is left out of the prompt: Amp asks for a
// secret's value in a private dialog. Settings shows this under Setup.
function renderCloudSetup(el) {
	el.innerHTML = `<details class="setup-more" id="amp-cloud">
		<summary>${t('setup.cloud.h')}</summary>
		<p>${t('setup.cloud.p1')}</p>
		<ol class="steps">
			<li><div>
				<h3>${t('setup.cloud.step1.h')}</h3>
				<p>${t('setup.cloud.step1.p')}</p>
				<p><button class="btn small primary" type="button" data-cloud-key>${t('setup.cloud.make')}</button></p>
				<div class="cmdbox" data-cloud-key-box hidden></div>
				<p class="fine" data-cloud-key-note role="status" hidden></p>
			</div></li>
			<li><div>
				<h3>${t('setup.cloud.step2.h')}</h3>
				<p>${t('setup.cloud.step2.p')}</p>
				${promptBox(t('setup.cloudPrompt', { origin: location.origin }))}
			</div></li>
			<li><div>
				<h3>${t('setup.cloud.step3.h')}</h3>
				<p>${t('setup.cloud.step3.p')}</p>
			</div></li>
		</ol>
		<p>${t('setup.cloud.check')}</p>
	</details>`
	const note = el.querySelector('[data-cloud-key-note]')
	// A new key for cloud sessions replaces the last one, which stops working.
	el.querySelector('[data-cloud-key]').addEventListener('click', async (e) => {
		const button = e.currentTarget
		button.disabled = true
		try {
			const made = await api('/api/sync-keys', { method: 'POST', body: JSON.stringify({ name: CLOUD_KEY, replace: true }) })
			// So is one made when the key was still named after Amp.
			const { keys } = await api('/api/sync-keys').catch(() => ({ keys: [] }))
			for (const k of keys) if (k.name === 'Amp cloud') await api('/api/sync-keys/' + k.id, { method: 'DELETE' }).catch(() => {})
			const box = el.querySelector('[data-cloud-key-box]')
			box.innerHTML = cmd(made.key, 'plain')
			box.hidden = false
			Object.assign(note, { textContent: t('setup.cloud.made'), hidden: false })
			button.textContent = t('setup.cloud.again')
			button.classList.remove('primary')
			document.dispatchEvent(new Event('sync-keys-changed')) // so a list of them shows it
		} catch (err) {
			Object.assign(note, { textContent: err.message, hidden: false })
		} finally {
			button.disabled = false
		}
	})
}

// renderSetup fills el with the flow that connects a computer to this
// account, one step at a time: an opening card, then how to set it up (by
// hand or by an agent), the command or prompt, what each tool needs, and
// last the code the terminal shows, typed into a form that posts to
// /connect, which still asks to allow the computer by its ID. Amp's cloud
// threads need no computer, so the tools step only points to their own
// steps (renderCloudSetup). With again, for a person who has a computer
// already, the opening card says "Add another computer".
function renderSetup(el, again = false) {
	const { sh, ps } = setupCommands()
	// What to paste into an agent so it does the setup itself. The questions
	// helios setup asks are answered up front, since an agent can't answer them.
	const prompt = t('setup.agentPrompt', {
		sh: `curl -fsSL ${INSTALL}.sh | HELIOS_NO_SETUP=1 sh`,
		ps: `$env:HELIOS_NO_SETUP=1; irm ${INSTALL}.ps1 | iex`,
		connect: `helios login -server ${location.origin}`,
	})

	let mode = 'self' // or 'agent'
	let os = null // the tab picked on the install step, kept when coming back to it
	const install = () => mode === 'agent'
		? `<p>${t('setup.agent.p')}</p>${promptBox(prompt)}<p class="fine">${t('setup.agent.fine')}</p>`
		: `<p>${t('setup.install.p')}</p>
			<div class="cmdbox setup-cmd" data-tabs${os ? ` data-default="${os}"` : ''}>
				<div class="tabs" role="tablist">
					<button type="button" data-tab="mac" role="tab">${t('os.mac')}</button>
					<button type="button" data-tab="linux" role="tab">${t('os.linux')}</button>
					<button type="button" data-tab="windows" role="tab">${t('os.windows')}</button>
				</div>
				<div class="tab-panel" data-tab="mac">${cmd(sh)}</div>
				<div class="tab-panel" data-tab="linux">${cmd(sh)}</div>
				<div class="tab-panel" data-tab="windows">${cmd(ps, 'ps')}</div>
			</div>`
	// Each step: its title, what it shows, and the label of the button that
	// moves on. A step without one moves on by itself: a choice, or a form.
	const steps = [
		{
			h: () => t('setup.choose.h'),
			body: () => `<p>${t('setup.choose.p')}</p>
				<div class="setup-choices">
					<button type="button" class="setup-choice" data-mode="self"><b>${t('setup.mode.self')}</b><span>${t('setup.choose.self')}</span></button>
					<button type="button" class="setup-choice" data-mode="agent"><b>${t('setup.mode.agent')}</b><span>${t('setup.choose.agent')}</span></button>
				</div>`,
		},
		{ h: () => t(mode === 'agent' ? 'setup.agentStep.h' : 'setup.install.h'), body: install, next: () => t(mode === 'agent' ? 'setup.pasted' : 'setup.ran') },
		{
			h: () => t('setup.tools.step.h'),
			body: () => `<p>${t('setup.tools.step.p')}</p>
				<div class="cmdbox tools" data-tabs data-default="claude">
					<div class="tabs" role="tablist">
						<button type="button" data-tab="claude" role="tab">Claude Code</button>
						<button type="button" data-tab="codex" role="tab">Codex</button>
						<button type="button" data-tab="amp" role="tab">Amp</button>
					</div>
					<div class="tab-panel" data-tab="claude"><p>${t('setup.tools.claude')}</p></div>
					<div class="tab-panel" data-tab="codex"><p>${t('setup.tools.codex')}</p></div>
					<div class="tab-panel" data-tab="amp"><p>${t('setup.tools.amp1')}</p>${cmd('helios setup amp')}<p>${t('setup.tools.amp2')}</p>
							<p>${t('setup.tools.ampCloud')}</p>
					</div>
				</div>`,
			next: () => t('setup.next'),
		},
		{
			h: () => t('setup.connect.h'),
			body: () => `<p>${t('setup.connect.p')}</p>
				<form class="code-form" method="post" action="/connect">
					<input name="user_code" aria-label="${esc(t('setup.connect.label'))}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" maxlength="12" required>
					<button class="btn primary">${t('setup.connect.go')}</button>
				</form>
				<p class="fine">${t('setup.connect.fine')}</p>`,
		},
	]

	// show puts step at on the page; -1 is the opening card.
	const show = (at, focus = true) => {
		if (at < 0) {
			el.innerHTML = `<div class="setup-flow setup-intro">
				<h2 tabindex="-1">${t(again ? 'setup.again.h' : 'setup.intro.h')}</h2>
				<p class="muted">${t(again ? 'setup.again.p' : 'setup.intro.p')}</p>
				<button class="btn primary" type="button" data-go="0">${t(again ? 'setup.again.go' : 'setup.intro.go')}</button>
			</div>`
		} else {
			const step = steps[at]
			el.innerHTML = `<div class="setup-flow">
				<div class="setup-progress">
					<span>${t('setup.progress', { n: at + 1, total: steps.length })}</span>
					<ol aria-hidden="true">${steps.map((_, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}"></li>`).join('')}</ol>
				</div>
				<h3 tabindex="-1">${step.h()}</h3>
				<div class="setup-body">${step.body()}</div>
				<div class="setup-nav">
					<button class="btn" type="button" data-go="${at - 1}">${t('setup.back')}</button>
					${step.next ? `<button class="btn primary" type="button" data-go="${at + 1}">${step.next()}</button>` : ''}
				</div>
			</div>`
		}
		initTabs(el)
		for (const b of el.querySelectorAll('.setup-cmd .tabs button')) b.addEventListener('click', () => (os = b.dataset.tab))
		if (!focus) return
		// The code is what the last step is for; elsewhere the step's title, so a screen reader reads it.
		const code = el.querySelector('input[name="user_code"]')
		;(code || el.querySelector('h2, h3')).focus()
	}

	el.onclick = (e) => {
		const choice = e.target.closest('[data-mode]')
		if (choice) {
			mode = choice.dataset.mode
			return show(1)
		}
		const go = e.target.closest('[data-go]')
		if (go) show(Number(go.dataset.go))
	}
	show(-1, false)
}
