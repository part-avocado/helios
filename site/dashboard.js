// The dashboard shows teardrop reports. On the hosted site they are the
// signed-in visitor's synced reports (/api/report). From `teardrop dashboard`
// it is one signed report made live on this computer.
const DAY = 86400000
const hosted = 'hosted' in document.documentElement.dataset
// Set when an admin opens someone else's stats from the People page.
const viewing = hosted ? new URLSearchParams(location.search).get('user') : null
let report = null
let days = 30
let live = false

const count = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
// Calendar days, not 24-hour steps, which land on the wrong day across a clock change.
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

function render() {
	if (!report) return
	const now = new Date()
	const from = addDays(now, -(days - 1))
	const blocks = (report.blocks || [])
		.map((b) => ({ ...b, s: new Date(b.start), e: new Date(b.end), tools: b.tools || [] }))
		.filter((b) => b.e >= from)

	// Per-day, per-hour, per-project, and per-tool totals from the blocks in range.
	const perDay = new Map(), perHour = new Array(24).fill(0), projects = new Map(), tools = new Map()
	let total = 0, prompts = 0, tin = 0, tout = 0
	for (const b of blocks) {
		total += b.engaged_seconds
		prompts += b.prompts
		tin += b.tokens_in
		tout += b.tokens_out
		const k = dayKey(b.s)
		perDay.set(k, (perDay.get(k) || 0) + b.engaged_seconds)
		// Spread engaged time over the hours the block spans.
		const span = Math.max(1, b.e - b.s)
		for (let t = b.s.getTime(); t < b.e.getTime() || t === b.s.getTime(); ) {
			const d = new Date(t)
			const next = Math.min(b.e.getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime())
			perHour[d.getHours()] += (b.engaged_seconds * Math.max(next - t, b.e > b.s ? 0 : 1)) / span
			if (next <= t) break
			t = next
		}
		const p = projects.get(b.project.key) || { name: b.project.name, engaged: 0, prompts: 0, tin: 0, tout: 0, blocks: 0 }
		p.engaged += b.engaged_seconds
		p.prompts += b.prompts
		p.tin += b.tokens_in
		p.tout += b.tokens_out
		p.blocks++
		projects.set(b.project.key, p)
		for (const t of b.tools.length ? b.tools : ['unknown']) {
			tools.set(t, (tools.get(t) || 0) + b.engaged_seconds / Math.max(1, b.tools.length))
		}
	}
	// Reports from teardrop 0.4 and later carry per-day totals that count time
	// on two projects at once only once, as the teardrop command does. Summing
	// blocks, the fallback for older reports, counts that time twice.
	const totals = dayTotals()
	if (totals) {
		perDay.clear()
		total = 0
		for (let i = 0; i < days; i++) {
			const k = dayKey(addDays(from, i)), v = totals.get(k) || 0
			if (v) perDay.set(k, v)
			total += v
		}
	}
	const noise = (report.projects || []).reduce((n, p) => n + (p.noise_prompts || 0) + (p.repeat_prompts || 0) + (p.autopilot_prompts || 0), 0)

	// Streak: consecutive days with activity, ending today (or yesterday, if nothing yet today).
	const allDays = new Set((report.blocks || []).map((b) => dayKey(new Date(b.start))))
	let streak = 0
	let d = startOfDay(now)
	if (!allDays.has(dayKey(d))) d = addDays(d, -1)
	while (allDays.has(dayKey(d))) {
		streak++
		d = addDays(d, -1)
	}

	const ranked = [...projects.values()].sort((a, b) => b.engaged - a.engaged)
	const today = perDay.get(dayKey(now)) || 0
	const activeDays = [...perDay.values()].filter((v) => v > 0).length
	$('s-total').textContent = dur(total)
	$('s-total-hint').textContent = `${activeDays} active ${activeDays === 1 ? 'day' : 'days'}, ${dur(activeDays ? total / activeDays : 0)} per active day`
	$('s-today').textContent = dur(today)
	$('s-today-hint').textContent = today ? 'keep going' : 'nothing yet today'
	$('s-streak').textContent = `${streak} ${streak === 1 ? 'day' : 'days'}`
	$('s-top').textContent = ranked[0]?.name || '-'
	$('s-top-hint').textContent = ranked[0] ? dur(ranked[0].engaged) : ''
	$('s-prompts').textContent = count(prompts)
	$('s-prompts-hint').textContent = noise ? `${noise} skipped` : 'none skipped'
	$('s-tokens').textContent = count(tin + tout)
	$('s-tokens-hint').textContent = `${count(tin)} read, ${count(tout)} written`

	renderHeatmap(now)
	renderBars(perDay, from)
	const maxHour = Math.max(1, ...perHour)
	$('hours').innerHTML = perHour.map((v, h) => `<div style="height:${(v / maxHour) * 100}%" title="${h}:00 · ${dur(v)}"></div>`).join('')

	const maxTool = Math.max(1, ...tools.values())
	$('tools').innerHTML = [...tools].sort((a, b) => b[1] - a[1]).map(([t, v]) =>
		`<div class="row"><div class="top"><span>${esc(t)}</span><span class="muted">${dur(v)}</span></div><div class="track"><div class="fill" style="width:${(v / maxTool) * 100}%"></div></div></div>`).join('') ||
		'<p class="muted">No activity in this range.</p>'

	$('projects').innerHTML = '<tr><th>Project</th><th>Engaged</th><th>Prompts</th><th>Tokens</th></tr>' +
		(ranked.map((p) => `<tr><td>${esc(p.name)}</td><td>${dur(p.engaged)}</td><td>${p.prompts}</td><td>${count(p.tin)}/${count(p.tout)}</td></tr>`).join('') ||
			'<tr><td colspan="4" class="muted">No activity in this range.</td></tr>')

	const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
	const hm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
	$('blocks').innerHTML = '<tr><th>When</th><th>Project</th><th>Engaged</th><th>Span</th><th>Prompts</th><th>Tokens</th><th>Tools</th></tr>' +
		(blocks.slice().sort((a, b) => b.s - a.s).slice(0, 25).map((b) =>
			`<tr><td>${fmt.format(b.s)}, ${hm.format(b.s)}–${hm.format(b.e)}</td><td>${esc(b.project.name)}</td><td>${dur(b.engaged_seconds)}</td><td>${dur((b.e - b.s) / 1000)}</td><td>${b.prompts}</td><td>${count(b.tokens_in)}/${count(b.tokens_out)}</td><td>${b.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td></tr>`).join('') ||
			'<tr><td colspan="7" class="muted">No activity in this range.</td></tr>')
}

// dayTotals returns the report's engaged seconds per day, keyed like dayKey,
// or null for a report without them.
function dayTotals() {
	if (!Array.isArray(report.days)) return null
	return new Map(report.days.map((d) => [d.date.split('-').map(Number).join('-'), d.engaged_seconds]))
}

// A year of days, one column per week, like a contribution graph.
function renderHeatmap(now) {
	const perDay = dayTotals() || new Map()
	if (!perDay.size) {
		for (const b of report.blocks || []) {
			const k = dayKey(new Date(b.start))
			perDay.set(k, (perDay.get(k) || 0) + b.engaged_seconds)
		}
	}
	const end = startOfDay(now)
	const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 364 - end.getDay())
	const colors = ['#efede7', '#c9e3fb', '#8cc0f0', '#4c97e4', '#1f64c4']
	const level = (s) => (s <= 0 ? 0 : s < 1800 ? 1 : s < 3600 ? 2 : s < 3 * 3600 ? 3 : 4)
	const cell = 13, gap = 3
	let rects = '', months = '', lastMonth = -1, col = 0
	const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
	for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
		const row = d.getDay()
		if (row === 0 && d > start) col++
		if (row === 0 && d.getMonth() !== lastMonth) {
			lastMonth = d.getMonth()
			months += `<text x="${30 + col * (cell + gap)}" y="10" fill="#8b8b94" font-size="11">${d.toLocaleString(undefined, { month: 'short' })}</text>`
		}
		const s = perDay.get(dayKey(d)) || 0
		rects += `<rect x="${30 + col * (cell + gap)}" y="${18 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${colors[level(s)]}"><title>${fmt.format(d)}: ${s ? dur(s) : 'no activity'}</title></rect>`
	}
	const labels = ['Mon', 'Wed', 'Fri'].map((t, i) => `<text x="0" y="${18 + (i * 2 + 1) * (cell + gap) + 10}" fill="#8b8b94" font-size="11">${t}</text>`).join('')
	const w = 30 + (col + 1) * (cell + gap)
	$('heatmap').innerHTML = `<svg width="${w}" height="${18 + 7 * (cell + gap)}" role="img" aria-label="Engaged time per day over the last year">${months}${labels}${rects}</svg>`
}

// One bar per day, or per week when a year of days wouldn't fit. Weeks are
// counted back from today, so no bar stands for less than a whole week.
function renderBars(perDay, from) {
	const step = days > 90 ? 7 : 1
	const n = Math.floor(days / step)
	const first = addDays(from, days - n * step)
	const vals = []
	for (let i = 0; i < n; i++) {
		const d = addDays(first, i * step)
		let v = 0
		for (let j = 0; j < step; j++) v += perDay.get(dayKey(addDays(d, j))) || 0
		vals.push([d, v])
	}
	const max = Math.max(1, ...vals.map((v) => v[1]))
	const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
	$('bars-title').textContent = step === 7 ? 'Engaged per week' : 'Engaged per day'
	$('bars').classList.toggle('dense', vals.length > 40)
	$('bars').innerHTML = vals.map(([d, v]) => `<div style="height:${(v / max) * 100}%" title="${step === 7 ? 'Week of ' : ''}${fmt.format(d)} · ${dur(v)}"></div>`).join('')
	$('bar-labels').innerHTML = `<span>${fmt.format(first)}</span><span>${fmt.format(addDays(from, days - 1))}</span>`
}

// verify checks a signed report from `teardrop dashboard` and returns its payload.
// The key is an Ed25519 signature of the payload text by the account inside it,
// so editing any number, the account, or a time makes it fail.
const SKEW = 5 * 60000
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
async function verify(file) {
	if (!file || typeof file.payload !== 'string' || typeof file.key !== 'string') {
		throw new Error('This report has no verification key.')
	}
	let p
	try {
		p = JSON.parse(file.payload)
	} catch {
		throw new Error('This report is damaged.')
	}
	let ok = false
	try {
		const key = await crypto.subtle.importKey('raw', b64u(p.account), { name: 'Ed25519' }, false, ['verify'])
		ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64u(file.key), new TextEncoder().encode(file.payload))
	} catch (e) {
		if (!crypto.subtle) throw new Error('Verification needs a secure page (https or localhost).')
		if (e?.name === 'NotSupportedError') throw new Error('This browser cannot check verification keys. Update it and try again.')
	}
	if (!ok) throw new Error('The verification key does not match this report.')
	const generated = Date.parse(p.generated_at), expires = Date.parse(p.expires_at), now = Date.now()
	if (!(generated <= now + SKEW)) throw new Error('This report says it was made in the future. Check your clock.')
	if (!(now <= expires)) throw new Error(`This report's key expired on ${new Date(expires).toLocaleString()}.`)
	if ((p.report?.blocks || []).some((b) => Date.parse(b.end) > generated + SKEW)) {
		throw new Error('This report has activity after the time it was made, which is not possible.')
	}
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', b64u(p.account)))
	p.accountID = 'td-' + [...digest.slice(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join('')
	return p
}

const verifiedNote = (p) =>
	`<span class="tag" title="Signed by this account; any change to the numbers or times would break the key"><svg class="ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>verified</span> account ${esc(p.accountID)} · key valid until ${esc(new Date(p.expires_at).toLocaleDateString())}`

// The page shows one of three things: stats, the setup steps, or a notice.
function reveal(id) {
	for (const part of ['content', 'setup', 'notice']) $(part).hidden = part !== id
	$('range').hidden = id !== 'content'
}

function show(rep, source) {
	report = rep
	reveal('content')
	$('status').innerHTML = source
	render()
}

function notice(title, html) {
	reveal('notice')
	$('status').textContent = ''
	$('notice-title').textContent = title
	$('notice-text').innerHTML = html
}

// merge adds up the latest report of each of a person's computers.
function merge(computers) {
	const reports = computers.map((c) => c.report.report || {})
	const perDay = new Map()
	for (const r of reports) for (const d of r.days || []) perDay.set(d.date, (perDay.get(d.date) || 0) + d.engaged_seconds)
	return {
		blocks: reports.flatMap((r) => r.blocks || []),
		projects: reports.flatMap((r) => r.projects || []),
		// Without per-day totals from every computer, render() adds up blocks instead.
		days: reports.every((r) => Array.isArray(r.days)) ? [...perDay].map(([date, engaged_seconds]) => ({ date, engaged_seconds })) : undefined,
	}
}

let setupReady = false
let sampled = false

// showSetup nudges a signed-in visitor with nothing synced to connect a computer.
async function showSetup() {
	if (!setupReady) {
		renderSetup($('setup-steps'), (await api('/api/me')).api_key)
		setupReady = true
	}
	reveal('setup')
	$('status').textContent = ''
}

async function loadHosted() {
	let body
	try {
		body = await api('/api/report' + (viewing ? `?user=${encodeURIComponent(viewing)}` : ''))
		if (viewing) {
			$('title').textContent = body.person.name ? `Stats for ${body.person.name}` : 'Their stats'
			document.querySelector('.nav .links .active')?.classList.remove('active')
		}
		if (!body.computers.length) {
			if (viewing) notice('Nothing synced yet', 'This person has signed in, but no computer of theirs has synced. <a href="people.html">Back to people</a>')
			else if (!sampled) await showSetup()
			setTimeout(loadHosted, 10000) // so the stats appear as soon as the first sync lands
			return
		}
	} catch (e) {
		if (report) $('status').textContent = 'Could not reach the server. Trying again.'
		else notice(viewing ? 'Could not load these stats' : 'Could not load your stats', esc(e.message))
		setTimeout(loadHosted, 15000)
		return
	}
	sampled = false
	const last = Math.max(...body.computers.map((c) => c.synced_at))
	const stale = Date.now() - last > 3 * DAY
	const from = body.computers.length === 1 ? '1 computer' : `${body.computers.length} computers`
	show(merge(body.computers), `<span class="dot${stale ? ' old' : ''}"></span>Synced ${esc(ago(last))} from ${from}` +
		(viewing ? ' · <a href="people.html">all people</a>' : stale ? ' · run <code>teardrop sync</code> to update' : ''))
	setTimeout(loadHosted, 5 * 60000)
}

// poll reads the live report that `teardrop dashboard` serves on this computer.
async function poll() {
	let body
	try {
		const res = await fetch('/api/report?since=365d', { cache: 'no-store' })
		if (!res.ok) throw new Error(res.status)
		body = await res.json()
	} catch {
		if (!live) {
			// A copy of the site with nothing behind it to ask.
			notice('Your stats live on your computer', 'Run <code>teardrop dashboard</code> to see them here, updated as you work. New to teardrop? <a href="docs.html#quick-start">Start here</a>.')
			return
		}
		// teardrop dashboard was stopped or the computer slept: keep the last stats and keep asking.
		$('status').textContent = 'Lost contact with teardrop dashboard. Start it again to keep updating.'
		setTimeout(poll, 5000)
		return
	}
	try {
		const p = await verify(body)
		live = true
		show(p.report, `<span class="dot live"></span>Live from this computer · updated ${new Date().toLocaleTimeString()} · ${verifiedNote(p)}`)
	} catch (e) {
		$('status').textContent = e.message
	}
	setTimeout(poll, 30000)
}

// Plausible fake data so visitors can see the dashboard before installing.
function sample() {
	let seed = 7
	const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
	const projects = [{ key: 'github.com/rowan/cs2-web', name: 'cs2-web' }, { key: 'github.com/rowan/notes', name: 'notes' }, { key: '/home/rowan/synth', name: 'synth' }]
	const toolsets = [['claude-code'], ['codex'], ['amp'], ['amp', 'claude-code']]
	const blocks = []
	const today = startOfDay(new Date())
	for (let i = 300; i >= 0; i--) {
		if (rnd() < 0.35 && i > 2) continue
		for (let n = 0; n < 1 + Math.floor(rnd() * 3); n++) {
			const s = new Date(today.getTime() - i * DAY + (9 + rnd() * 12) * 3600000)
			if (s > new Date()) continue
			const engaged = 600 + Math.floor(rnd() * 5400)
			const prompts = 2 + Math.floor(engaged / 300 * rnd())
			blocks.push({
				project: projects[Math.floor(rnd() ** 1.6 * 3)], start: s.toISOString(),
				end: new Date(s.getTime() + engaged * (1.05 + rnd() * 0.4) * 1000).toISOString(),
				engaged_seconds: engaged, prompts, tokens_in: prompts * 40000, tokens_out: prompts * 1800,
				tools: toolsets[Math.floor(rnd() * 4)],
			})
		}
	}
	return { blocks, projects: [{ noise_prompts: 1, repeat_prompts: 4, autopilot_prompts: 6 }], engaged_seconds: 0 }
}

for (const b of document.querySelectorAll('#range button')) {
	b.addEventListener('click', () => {
		days = Number(b.dataset.days)
		for (const o of document.querySelectorAll('#range button')) o.setAttribute('aria-pressed', String(o === b))
		render()
	})
}
for (const el of document.querySelectorAll('.sample')) {
	el.addEventListener('click', (e) => {
		e.preventDefault()
		sampled = true
		show(sample(), 'Sample data · <a href="#" id="unsample">hide it</a>')
		$('unsample').onclick = (e) => {
			e.preventDefault()
			sampled = false
			report = null
			if (hosted) showSetup()
			else poll()
		}
	})
}

if (hosted) loadHosted()
else poll()
