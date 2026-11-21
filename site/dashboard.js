// The dashboard reads a teardrop report: live from `teardrop dashboard`
// (/api/report), or from a `teardrop -json` file the visitor loads.
const $ = (id) => document.getElementById(id)
const DAY = 86400000
let report = null
let days = 30
let live = false

const esc = (s) => String(s).replace(/[&<>\"']/g, (c) => `&#${c.charCodeAt(0)};`)
const dur = (sec) => {
	const m = Math.round(sec / 60)
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const count = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

function render() {
	if (!report) return
	const now = new Date()
	const from = new Date(startOfDay(now).getTime() - (days - 1) * DAY)
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
	const noise = (report.projects || []).reduce((n, p) => n + (p.noise_prompts || 0) + (p.repeat_prompts || 0) + (p.autopilot_prompts || 0), 0)

	// Streak: consecutive days with activity, ending today (or yesterday, if nothing yet today).
	const allDays = new Set((report.blocks || []).map((b) => dayKey(new Date(b.start))))
	let streak = 0
	let d = startOfDay(now)
	if (!allDays.has(dayKey(d))) d = new Date(d.getTime() - DAY)
	while (allDays.has(dayKey(d))) {
		streak++
		d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
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

// A year of days, one column per week, like a contribution graph.
function renderHeatmap(now) {
	const perDay = new Map()
	for (const b of report.blocks || []) {
		const k = dayKey(new Date(b.start))
		perDay.set(k, (perDay.get(k) || 0) + b.engaged_seconds)
	}
	const end = startOfDay(now)
	const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 364 - end.getDay())
	const colors = ['#23232d', '#1d4a78', '#2a6cb0', '#4aa3ff', '#9fd3ff']
	const level = (s) => (s <= 0 ? 0 : s < 1800 ? 1 : s < 3600 ? 2 : s < 3 * 3600 ? 3 : 4)
	const cell = 13, gap = 3
	let rects = '', months = '', lastMonth = -1, col = 0
	const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
	for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
		const row = d.getDay()
		if (row === 0 && d > start) col++
		if (row === 0 && d.getMonth() !== lastMonth) {
			lastMonth = d.getMonth()
			months += `<text x="${30 + col * (cell + gap)}" y="10" fill="#9d9db0" font-size="11">${d.toLocaleString(undefined, { month: 'short' })}</text>`
		}
		const s = perDay.get(dayKey(d)) || 0
		rects += `<rect x="${30 + col * (cell + gap)}" y="${18 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${colors[level(s)]}"><title>${fmt.format(d)}: ${s ? dur(s) : 'no activity'}</title></rect>`
	}
	const labels = ['Mon', 'Wed', 'Fri'].map((t, i) => `<text x="0" y="${18 + (i * 2 + 1) * (cell + gap) + 10}" fill="#9d9db0" font-size="11">${t}</text>`).join('')
	const w = 30 + (col + 1) * (cell + gap)
	$('heatmap').innerHTML = `<svg width="${w}" height="${18 + 7 * (cell + gap)}" role="img" aria-label="Engaged time per day over the last year">${months}${labels}${rects}</svg>`
}

function renderBars(perDay, from) {
	const vals = []
	for (let i = 0; i < days; i++) {
		const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)
		vals.push([d, perDay.get(dayKey(d)) || 0])
	}
	const max = Math.max(1, ...vals.map((v) => v[1]))
	const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
	$('bars').innerHTML = vals.map(([d, v]) => `<div style="height:${(v / max) * 100}%" title="${fmt.format(d)} · ${dur(v)}"></div>`).join('')
	$('bar-labels').innerHTML = `<span>${fmt.format(vals[0][0])}</span><span>${fmt.format(vals[vals.length - 1][0])}</span>`
}

// verify checks a signed report from `teardrop export` and returns its payload.
// The key is an Ed25519 signature of the payload text by the account inside it,
// so editing any number, the account, or a time makes it fail.
const SKEW = 5 * 60000
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
async function verify(file) {
	if (!file || typeof file.payload !== 'string' || typeof file.key !== 'string') {
		throw new Error('This file has no verification key. Make one with: teardrop export -o stats.json')
	}
	let p
	try {
		p = JSON.parse(file.payload)
	} catch {
		throw new Error('This file is damaged. Export it again.')
	}
	let ok = false
	try {
		const key = await crypto.subtle.importKey('raw', b64u(p.account), { name: 'Ed25519' }, false, ['verify'])
		ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64u(file.key), new TextEncoder().encode(file.payload))
	} catch (e) {
		if (!crypto.subtle) throw new Error('Verification needs a secure page (https or localhost).')
		if (e?.name === 'NotSupportedError') throw new Error('This browser cannot check verification keys. Update it and try again.')
	}
	if (!ok) throw new Error('The verification key does not match this file. It was changed after it was exported.')
	const generated = Date.parse(p.generated_at), expires = Date.parse(p.expires_at), now = Date.now()
	if (!(generated <= now + SKEW)) throw new Error('This file says it was made in the future. Check your clock and export it again.')
	if (!(now <= expires)) throw new Error(`This file's key expired on ${new Date(expires).toLocaleString()}. Export a fresh one.`)
	if ((p.report?.blocks || []).some((b) => Date.parse(b.end) > generated + SKEW)) {
		throw new Error('This file has activity after the time it was made, which is not possible. Export it again.')
	}
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', b64u(p.account)))
	p.accountID = 'td-' + [...digest.slice(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join('')
	return p
}

const verifiedNote = (p) =>
	`<span class="tag" title="Signed by this account; any change to the numbers or times would break the key">✓ verified</span> account ${esc(p.accountID)} · key valid until ${esc(new Date(p.expires_at).toLocaleDateString())}`

function show(rep, source) {
	report = rep
	$('empty').hidden = true
	$('content').hidden = false
	$('status').innerHTML = source
	render()
}

async function poll() {
	let body
	try {
		const res = await fetch('/api/report?since=365d', { cache: 'no-store' })
		if (!res.ok) throw new Error(res.status)
		body = await res.json()
	} catch {
		if (!live) $('empty').hidden = false
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

function loadFile(file) {
	$('file-error').hidden = true
	file.text().then(async (t) => {
		try {
			let body
			try {
				body = JSON.parse(t)
			} catch {
				throw new Error('That file is not a teardrop report. Make one with: teardrop export -o stats.json')
			}
			const p = await verify(body)
			show(p.report, `${esc(file.name)} · ${verifiedNote(p)} · <a href="#" id="clear">load another</a>`)
			$('clear').onclick = (e) => {
				e.preventDefault()
				$('content').hidden = true
				$('empty').hidden = false
			}
		} catch (e) {
			$('file-error').textContent = e.message
			$('file-error').hidden = false
		}
	})
	$('file').value = '' // so choosing the same file again still loads it
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
$('file').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]))
const drop = $('drop')
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')))
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
	e.preventDefault()
	drop.classList.remove('over')
	if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0])
})
$('sample').addEventListener('click', () => show(sample(), 'Sample data · <a href="docs.html#dashboard">see your own</a>'))

poll()
