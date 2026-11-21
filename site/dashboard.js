// The dashboard shows teardrop reports. On the hosted site they are the
// signed-in visitor's synced reports (/api/report). From `teardrop dashboard`
// it is one signed report made live on this computer.
const DAY = 86400000
const hosted = 'hosted' in document.documentElement.dataset
// Set when an admin opens someone else's stats from the Review page.
const viewing = hosted ? new URLSearchParams(location.search).get('user') : null
let report = null
let days = 30
let live = false

const count = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
// Calendar days, not 24-hour steps, which land on the wrong day across a clock change.
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

// What the visitor has picked. Clicking a day on the heatmap or a bar picks
// that day (a week, on the yearly chart) and shows its work blocks below.
// Clicking a project picks it, and then every number and chart follows it.
// Clicking either again clears it.
let heatScrolled = false
let pick = null // { from: Date, to: Date, label: string }
let only = null // a project key

const fmtDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const fmtShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const hm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const hourName = (h) => new Date(2000, 0, 1, h % 24).toLocaleTimeString(undefined, { hour: 'numeric' })
const pct = (v, of) => (of ? Math.round((v / of) * 100) : 0) + '%'

// tipAttrs makes an element show the tooltip: a title, a line under it, and
// an optional hint about clicking.
const tipAttrs = (title, body, hint = '') => ` data-tip="${esc(title)}" data-body="${esc(body)}" data-hint="${esc(hint)}"`
const X = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'

function render() {
	if (!report) return
	const now = new Date()
	const from = addDays(now, -(days - 1))
	const all = (report.blocks || []).map((b) => ({ ...b, s: new Date(b.start), e: new Date(b.end), tools: b.tools || [] }))
	if (only && !all.some((b) => b.project.key === only)) only = null
	const scoped = only ? all.filter((b) => b.project.key === only) : all
	const blocks = scoped.filter((b) => b.e >= from)

	// Per-day, per-hour, and per-tool totals from the blocks in range.
	const perDay = new Map(), perHour = new Array(24).fill(0), tools = new Map()
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
		for (const t of b.tools.length ? b.tools : ['unknown']) {
			tools.set(t, (tools.get(t) || 0) + b.engaged_seconds / Math.max(1, b.tools.length))
		}
	}
	// The table lists every project in range, so another can be picked at any time.
	const projects = new Map()
	for (const b of all) {
		if (b.e < from) continue
		const p = projects.get(b.project.key) || { key: b.project.key, name: b.project.name, engaged: 0, prompts: 0, tin: 0, tout: 0 }
		p.engaged += b.engaged_seconds
		p.prompts += b.prompts
		p.tin += b.tokens_in
		p.tout += b.tokens_out
		projects.set(b.project.key, p)
	}
	// Reports from teardrop 0.4 and later carry per-day totals that count time
	// on two projects at once only once, as the teardrop command does. Summing
	// blocks, the fallback for older reports and for one project, counts that
	// time twice.
	const totals = only ? null : dayTotals()
	if (totals) {
		perDay.clear()
		total = 0
		for (let i = 0; i < days; i++) {
			const k = dayKey(addDays(from, i)), v = totals.get(k) || 0
			if (v) perDay.set(k, v)
			total += v
		}
	}
	const noise = (report.projects || [])
		.filter((p) => !only || p.project?.key === only)
		.reduce((n, p) => n + (p.noise_prompts || 0) + (p.repeat_prompts || 0) + (p.autopilot_prompts || 0), 0)

	// Streak: consecutive days with activity, ending today (or yesterday, if nothing yet today).
	const allDays = new Set(scoped.map((b) => dayKey(b.s)))
	let streak = 0
	let d = startOfDay(now)
	if (!allDays.has(dayKey(d))) d = addDays(d, -1)
	while (allDays.has(dayKey(d))) {
		streak++
		d = addDays(d, -1)
	}

	const ranked = [...projects.values()].sort((a, b) => b.engaged - a.engaged)
	const top = only ? projects.get(only) : ranked[0]
	const today = perDay.get(dayKey(now)) || 0
	const activeDays = [...perDay.values()].filter((v) => v > 0).length
	$('s-total').textContent = dur(total)
	$('s-total-hint').textContent = `${activeDays} active ${activeDays === 1 ? 'day' : 'days'}, ${dur(activeDays ? total / activeDays : 0)} per active day`
	$('s-today').textContent = dur(today)
	$('s-today-hint').textContent = today ? 'keep going' : 'nothing yet today'
	$('s-streak').textContent = `${streak} ${streak === 1 ? 'day' : 'days'}`
	$('s-top').textContent = top?.name || '-'
	$('s-top-hint').textContent = top ? dur(top.engaged) : ''
	$('s-prompts').textContent = count(prompts)
	$('s-prompts-hint').textContent = noise ? `${noise} skipped` : 'none skipped'
	$('s-tokens').textContent = count(tin + tout)
	$('s-tokens-hint').textContent = `${count(tin)} read, ${count(tout)} written`

	renderChips(projects, scoped)
	renderHeatmap(now, scoped)
	renderBars(perDay, from)

	const maxHour = Math.max(...perHour)
	$('hours-peak').textContent = maxHour > 0 ? `busiest ${hourName(perHour.indexOf(maxHour))}` : ''
	$('hours').innerHTML = perHour.map((v, h) =>
		`<div class="col"${tipAttrs(`${hourName(h)} to ${hourName(h + 1)}`, v ? `${dur(v)}, ${pct(v, perHour.reduce((a, b) => a + b, 0))} of your day's work` : 'No activity')}><i style="height:${maxHour ? (v / maxHour) * 100 : 0}%"></i></div>`).join('')

	const toolTotal = [...tools.values()].reduce((a, b) => a + b, 0)
	const maxTool = Math.max(1, ...tools.values())
	$('tools').innerHTML = [...tools].sort((a, b) => b[1] - a[1]).map(([t, v]) =>
		`<div class="row"${tipAttrs(t, `${dur(v)}, ${pct(v, toolTotal)} of the time`)}><div class="top"><span>${esc(t)}</span><span class="muted">${dur(v)}</span></div><div class="track"><div class="fill" style="width:${(v / maxTool) * 100}%"></div></div></div>`).join('') ||
		'<p class="muted">No activity in this range.</p>'

	$('projects').innerHTML = '<tr><th>Project</th><th>Engaged</th><th>Prompts</th><th>Tokens</th></tr>' +
		(ranked.map((p) => `<tr class="pick${only === p.key ? ' sel' : ''}" data-project="${esc(p.key)}"><td><button type="button" class="link" aria-pressed="${only === p.key}" title="${only === p.key ? 'Show all projects' : 'Show only this project'}">${esc(p.name)}</button></td><td>${dur(p.engaged)}</td><td>${p.prompts}</td><td>${count(p.tin)}/${count(p.tout)}</td></tr>`).join('') ||
			'<tr><td colspan="4" class="muted">No activity in this range.</td></tr>')

	// With a day picked, list that day's blocks, even if it is outside the range above.
	const listed = (pick ? scoped.filter((b) => b.s >= pick.from && b.s < pick.to) : blocks).slice().sort((a, b) => b.s - a.s)
	$('blocks-title').textContent = pick ? `Work blocks - ${pick.label}` : 'Recent work blocks'
	$('blocks').innerHTML = '<tr><th>When</th><th>Project</th><th>Engaged</th><th>Span</th><th>Prompts</th><th>Tokens</th><th>Tools</th></tr>' +
		(listed.slice(0, pick ? 100 : 25).map((b) =>
			`<tr><td>${fmtDay.format(b.s)}, ${hm.format(b.s)}–${hm.format(b.e)}</td><td>${esc(b.project.name)}</td><td>${dur(b.engaged_seconds)}</td><td>${dur((b.e - b.s) / 1000)}</td><td>${b.prompts}</td><td>${count(b.tokens_in)}/${count(b.tokens_out)}</td><td>${b.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td></tr>`).join('') ||
			`<tr><td colspan="7" class="muted">${pick ? 'No work blocks in this range.' : 'No activity in this range.'}</td></tr>`)
}

// renderChips shows what is picked, each with a way to clear it.
function renderChips(projects, scoped) {
	const chips = []
	if (only) chips.push(`<button type="button" class="chip" data-clear="project" title="Show all projects">${esc(projects.get(only)?.name || scoped[0]?.project.name || only)}${X}</button>`)
	if (pick) {
		const inPick = scoped.filter((b) => b.s >= pick.from && b.s < pick.to)
		const secs = inPick.reduce((n, b) => n + b.engaged_seconds, 0)
		chips.push(`<button type="button" class="chip" data-clear="pick" title="Back to the whole range">${esc(pick.label)} - ${dur(secs)}${X}</button>`)
		chips.push('<a class="link" href="#blocks-panel">See its work blocks</a>')
	}
	$('chips').hidden = !chips.length
	$('chips').innerHTML = chips.length ? '<span class="muted">Showing</span>' + chips.join('') : ''
}

// dayTotals returns the report's engaged seconds per day, keyed like dayKey,
// or null for a report without them.
function dayTotals() {
	if (!Array.isArray(report.days)) return null
	return new Map(report.days.map((d) => [d.date.split('-').map(Number).join('-'), d.engaged_seconds]))
}

// picked says whether the days from d for span days overlap the picked ones.
const picked = (d, span) => pick && pick.from < addDays(d, span) && pick.to > d

// A year of days, one column per week, like a contribution graph.
function renderHeatmap(now, scoped) {
	const perDay = (!only && dayTotals()) || new Map()
	if (!perDay.size) {
		for (const b of scoped) {
			const k = dayKey(b.s)
			perDay.set(k, (perDay.get(k) || 0) + b.engaged_seconds)
		}
	}
	const end = startOfDay(now)
	const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 364 - end.getDay())
	const colors = ['#efede7', '#c9e3fb', '#8cc0f0', '#4c97e4', '#1f64c4']
	const level = (s) => (s <= 0 ? 0 : s < 1800 ? 1 : s < 3600 ? 2 : s < 3 * 3600 ? 3 : 4)
	const cell = 13, gap = 3
	let rects = '', months = '', lastMonth = -1, col = 0
	for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
		const row = d.getDay()
		if (row === 0 && d > start) col++
		if (row === 0 && d.getMonth() !== lastMonth) {
			lastMonth = d.getMonth()
			months += `<text x="${30 + col * (cell + gap)}" y="10" fill="#8b8b94" font-size="11">${d.toLocaleString(undefined, { month: 'short' })}</text>`
		}
		const s = perDay.get(dayKey(d)) || 0
		const click = s > 0 ? ` class="has${picked(d, 1) ? ' sel' : ''}" data-ts="${d.getTime()}" data-span="1"` : ''
		rects += `<rect x="${30 + col * (cell + gap)}" y="${18 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${colors[level(s)]}"${click}${tipAttrs(fmtDate.format(d), s ? dur(s) : 'No activity', s ? 'Click to see this day' : '')}/>`
	}
	const labels = ['Mon', 'Wed', 'Fri'].map((t, i) => `<text x="0" y="${18 + (i * 2 + 1) * (cell + gap) + 10}" fill="#8b8b94" font-size="11">${t}</text>`).join('')
	const w = 30 + (col + 1) * (cell + gap)
	$('heatmap').innerHTML = `<svg width="${w}" height="${18 + 7 * (cell + gap)}" role="img" aria-label="Engaged time per day over the last year">${months}${labels}${rects}</svg>`
	// The first time, start on the latest weeks, which is what the eye wants on a narrow screen.
	if (!heatScrolled) $('heatmap').scrollLeft = $('heatmap').scrollWidth, (heatScrolled = true)
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
	const max = Math.max(...vals.map((v) => v[1]))
	$('bars-title').textContent = step === 7 ? 'Engaged per week' : 'Engaged per day'
	$('bars-peak').textContent = max > 0 ? `peak ${dur(max)}` : ''
	$('bars').classList.toggle('dense', vals.length > 40)
	$('bars').innerHTML = vals.map(([d, v]) => {
		const label = step === 7 ? `Week of ${fmtShort.format(d)}` : fmtDate.format(d)
		const click = v > 0 ? ` data-ts="${d.getTime()}" data-span="${step}" data-label="${esc(label)}"` : ''
		return `<button type="button" class="col${picked(d, step) ? ' sel' : ''}"${click}${v > 0 ? '' : ' tabindex="-1"'}${tipAttrs(label, v ? dur(v) : 'No activity', v ? `Click to see ${step === 7 ? 'this week' : 'this day'}` : '')}><i style="height:${max ? Math.max((v / max) * 100, v ? 1.5 : 0) : 0}%"></i></button>`
	}).join('')
	$('bar-labels').innerHTML = `<span>${fmtShort.format(first)}</span><span>${fmtShort.format(addDays(from, days - 1))}</span>`
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
	`<span class="tag" title="Signed by this account; any change to the numbers or times would break the key"><svg class="ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>verified</span> account ${esc(p.accountID)} - key valid until ${esc(new Date(p.expires_at).toLocaleDateString())}`

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
			else await showSetup()
			setTimeout(loadHosted, 10000) // so the stats appear as soon as the first sync lands
			return
		}
	} catch (e) {
		if (report) $('status').textContent = 'Could not reach the server. Trying again.'
		else notice(viewing ? 'Could not load these stats' : 'Could not load your stats', esc(e.message))
		setTimeout(loadHosted, 15000)
		return
	}
	const last = Math.max(...body.computers.map((c) => c.synced_at))
	const stale = Date.now() - last > 3 * DAY
	const from = body.computers.length === 1 ? '1 computer' : `${body.computers.length} computers`
	show(merge(body.computers), `<span class="dot${stale ? ' old' : ''}"></span>Synced ${esc(ago(last))} from ${from}` +
		(viewing ? ` - <a href="person.html?id=${encodeURIComponent(viewing)}">review</a> - <a href="people.html">all people</a>` : stale ? ' - run <code>teardrop sync</code> to update' : ''))
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
		show(p.report, `<span class="dot live"></span>Live from this computer - updated ${new Date().toLocaleTimeString()} - ${verifiedNote(p)}`)
	} catch (e) {
		$('status').textContent = e.message
	}
	setTimeout(poll, 30000)
}

for (const b of document.querySelectorAll('#range button')) {
	b.addEventListener('click', () => {
		days = Number(b.dataset.days)
		for (const o of document.querySelectorAll('#range button')) o.setAttribute('aria-pressed', String(o === b))
		render()
	})
}
// Clicking a day or week, or a project, narrows the page to it; clicking it
// again, or its chip, widens it back.
$('content').addEventListener('click', (e) => {
	const clear = e.target.closest('[data-clear]')?.dataset.clear
	if (clear === 'project') only = null
	else if (clear === 'pick') pick = null
	else {
		const day = e.target.closest('[data-ts]')
		const row = e.target.closest('[data-project]')
		if (day) {
			const from = new Date(Number(day.dataset.ts)), to = addDays(from, Number(day.dataset.span))
			const same = pick && pick.from.getTime() === from.getTime() && pick.to.getTime() === to.getTime()
			pick = same ? null : { from, to, label: day.dataset.label || fmtDate.format(from) }
		} else if (row) {
			only = only === row.dataset.project ? null : row.dataset.project
		} else return
	}
	render()
})

// Tooltips: one box that follows the pointer, and sits above a focused bar.
const tipBox = $('tip')
function showTip(el) {
	tipBox.querySelector('b').textContent = el.dataset.tip
	tipBox.querySelector('span').textContent = el.dataset.body
	tipBox.querySelector('em').textContent = el.dataset.hint
	tipBox.querySelector('em').hidden = !el.dataset.hint
	tipBox.hidden = false
}
function moveTip(x, y) {
	const box = tipBox.getBoundingClientRect()
	let left = x + 14, top = y - box.height - 12
	if (left + box.width > innerWidth - 8) left = x - box.width - 14
	if (top < 8) top = y + 20
	tipBox.style.transform = `translate(${Math.round(Math.max(8, left))}px, ${Math.round(top)}px)`
}
const hideTip = () => (tipBox.hidden = true)
$('content').addEventListener('pointermove', (e) => {
	const el = e.target.closest('[data-tip]')
	if (!el) return hideTip()
	showTip(el)
	moveTip(e.clientX, e.clientY)
})
$('content').addEventListener('pointerleave', hideTip)
$('content').addEventListener('focusin', (e) => {
	const el = e.target.closest('[data-tip]')
	if (!el) return
	showTip(el)
	const r = el.getBoundingClientRect()
	moveTip(r.left + r.width / 2, r.top)
})
$('content').addEventListener('focusout', hideTip)
document.addEventListener('pointerdown', (e) => e.target.closest('#content') || hideTip())
addEventListener('scroll', hideTip, { passive: true })

if (hosted) loadHosted()
else poll()
