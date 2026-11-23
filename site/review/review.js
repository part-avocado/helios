// The review app. What it shows depends on the visitor's level: a reviewer
// (2) looks a person up and reads their total for each project; a neoadmin
// (1) and a superadmin (0) read everything and manage reviewers and bans.
// The server decides what each may do. This page only leaves out what the
// server would refuse.
const $ = (id) => document.getElementById(id)
const view = $('view')
const root = document.documentElement
// The side menu stays folded to its icons for whoever folded it.
const SIDE = 'teardrop-review-side'
try {
	if (localStorage.getItem(SIDE) === 'closed') root.dataset.side = 'closed'
} catch {
	// Storage is blocked, so the choice lasts for this page only.
}
// The keys that go to the search box.
const KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const dur = (sec) => {
	const m = Math.round(sec / 60)
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const num = (n) => Number(n).toLocaleString()
const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const exact = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
const longDate = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'long' })

// ago says how far from now a time is, such as "3 minutes ago" or "in 2 days".
function ago(ms) {
	const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
	const seconds = (ms - Date.now()) / 1000
	for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
		if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit)
	}
	return 'just now'
}

const LEVELS = ['Superadmin', 'Neoadmin', 'Reviewer']
const CAN = [
	'read every account, add and remove neoadmins and reviewers, and ban anyone but another superadmin',
	'read every account, add and remove reviewers, and ban members and reviewers',
	'look a person up by Slack ID and read their total and work-block timeline for each project',
]
// Who is signed in: {name, slack_id, level}.
let me = null

// api calls the review API as the signed-in visitor, and throws the server's
// own words when it refuses.
async function api(path, init) {
	const res = await fetch('/api/review' + path, { cache: 'no-store', ...init })
	if (res.status === 401) {
		location.href = '/login?next=' + encodeURIComponent('/review/')
		throw new Error('Signing you in again…')
	}
	if (!res.ok) throw new Error((await res.text()).trim() || `The server answered ${res.status}.`)
	return res.json()
}
const send = (method, path, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

const badge = (level) => `<span class="badge l${level}">${LEVELS[level]}</span>`
const named = (name, slack) => `${name ? `<b>${esc(name)}</b> ` : ''}<code>${esc(slack)}</code>`
const head = (title, extra = '') => `<div class="dash-head"><h1>${title}</h1>${extra}</div>`
const notice = (title, text) => `<div class="empty"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>`
// lookup is the search box at the top of a page. Whoever has the list of
// people finds one by name or Slack ID, as in Home's box. A reviewer has no
// list, and types a Slack ID.
const lookup = () => `<form class="lookup" role="search" data-form="find">
	<input name="q" autocomplete="off" spellcheck="false" required ${me.level === 2
		? 'aria-label="Slack ID" placeholder="Slack ID, such as U012ABCDEF"'
		: 'aria-label="Search people" placeholder="Name or Slack ID" role="combobox" aria-expanded="false" aria-autocomplete="list"'}>
	<button class="btn">Look up</button>
	${me.level === 2 ? '' : '<div class="rv-found" role="listbox" hidden></div>'}
</form>`

function say(el, text, ok = false) {
	el.textContent = text
	el.className = 'msg ' + (ok ? 'ok' : 'bad')
	el.hidden = false
}

// ---- Home

// Everyone that a search box looks through. A reviewer has no list, and looks a person up by Slack ID.
let everyone = []
const SEARCH = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>'
const asSlackID = (text) => text.trim().replace(/^<@|>$/g, '').toUpperCase()
const SLACK_ID = /^[UW][A-Z0-9]{4,}$/
// The words typed in a search box, and whether a person's name or Slack ID holds them all.
const wordsIn = (input) => (input?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean)
const holds = (p, words) => words.every((w) => `${p.name} ${p.slack_id}`.toLowerCase().includes(w))
const personName = (p) => p.name || (p.deleted_at ? 'Deleted account' : 'No name')

function greeting() {
	const hour = new Date().getHours()
	return hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening'
}

async function home() {
	const limited = me.level === 2
	let note = "In Slack: open their profile, choose ⋮, then Copy member ID. As a reviewer you see a person's total and work-block timeline for each project, and not their computers, days, or log."
	if (!limited) {
		everyone = (await api('/people')).people
		const flagged = everyone.filter((p) => p.flagged).length
		const last = Math.max(0, ...everyone.map((p) => p.synced_at ?? 0))
		note = [plural(everyone.length, 'person', 'people'), flagged ? `${num(flagged)} with flagged reports` : 'no flagged reports', last ? `last sync ${ago(last)}` : 'nothing synced yet'].join(' - ')
	}
	return `<div class="rv-home">
		<h1>${greeting()}${me.name ? `, ${esc(me.name)}` : ''}</h1>
		<form class="rv-find" role="search" data-form="find">
			<label>${SEARCH}<input id="find" name="q" autocomplete="off" spellcheck="false" ${limited
				? 'aria-label="Slack ID" placeholder="Slack ID, such as U012ABCDEF" required'
				: 'aria-label="Search people" placeholder="Search people…" role="combobox" aria-expanded="false" aria-controls="found" aria-autocomplete="list"'}><kbd>${KEYS}</kbd></label>
			<div class="rv-found" id="found" role="listbox" hidden></div>
		</form>
		<p class="note">${esc(note)}</p>
	</div>`
}

// showFound lists, under a search box, the people whose name or Slack ID
// holds every word typed. Someone who never signed in is not among them, so
// a Slack ID that matches no one can still be looked up. On People the table
// is the list: it narrows to who matches, and the box under the search opens
// only when no one does.
async function showFound(form) {
	const input = form.elements.q, box = form.querySelector('.rv-found')
	if (!everyone.length) everyone = (await api('/people')).people
	const words = wordsIn(input)
	const table = view.querySelector('table.people')
	const hits = table ? drawPeople() : !words.length ? [] : everyone.filter((p) => holds(p, words))
	const rows = table ? [] : hits.slice(0, 8)
		.map((p) => `<a role="option" href="#/person/id:${p.id}"><span class="grow"><b>${esc(personName(p))}</b>${p.slack_id ? ` <code>${esc(p.slack_id)}</code>` : ''}</span>${p.banned ? '<span class="badge banned">Banned</span>' : ''}${p.flagged ? `<span class="badge flagged">${num(p.flagged)} flagged</span>` : ''}<small>${dur(p.engaged_seconds)}</small></a>`)
	const id = asSlackID(input.value)
	if (!hits.length && SLACK_ID.test(id)) rows.push(`<a role="option" href="#/person/${encodeURIComponent(id)}"><span class="grow">Look up Slack ID <code>${esc(id)}</code></span></a>`)
	box.innerHTML = rows.join('') || '<p>No one matches. A Slack ID, such as U012ABCDEF, finds someone who has not signed in.</p>'
	box.querySelector('a')?.setAttribute('aria-selected', 'true')
	box.hidden = !words.length || Boolean(table && hits.length)
	input.setAttribute('aria-expanded', String(!box.hidden))
}
// A search box lists people only for those who have the list. If the list
// can't be read, a Slack ID typed in full still opens its person.
const find = (form) => me.level < 2 && showFound(form).catch(() => {})

// toFind puts the cursor in Home's search box, going Home first if need be.
let findWanted = false
function toFind() {
	delete root.dataset.menu
	if ($('find')) return $('find').focus()
	findWanted = true
	location.hash = '#/'
}

// ---- People

// How People's table is narrowed and ordered, kept while the app is open.
// The server lists people by their last sync, newest first.
const listing = { synced: false, by: '' }
const ORDERS = {
	'': ['Last sync, newest first', null],
	name: ['Name', (a, b) => personName(a).localeCompare(personName(b))],
	engaged: ['Engaged, most first', (a, b) => b.engaged_seconds - a.engaged_seconds],
	flagged: ['Flagged, most first', (a, b) => b.flagged - a.flagged],
}

// drawPeople fills People's table: who matches the words in the search box,
// only those who have synced if asked, in the order chosen. It returns them.
function drawPeople() {
	const words = wordsIn(view.querySelector('.lookup input'))
	const list = everyone.filter((p) => holds(p, words) && (!listing.synced || p.synced_at))
	if (ORDERS[listing.by][1]) list.sort(ORDERS[listing.by][1])
	$('people-rows').innerHTML = list.map((p) => `<tr data-id="${p.id}"${p.banned ? ' class="is-banned"' : ''}>
		<td><a href="#/person/id:${p.id}">${esc(personName(p))}</a>${p.banned ? ' <span class="badge banned">Banned</span>' : ''}</td>
		<td>${p.slack_id ? `<code>${esc(p.slack_id)}</code>` : '<span class="muted">none</span>'}</td>
		<td>${dur(p.engaged_seconds)}</td><td>${p.computers}</td>
		<td>${p.flagged ? `<a class="flag" href="#/person/id:${p.id}">${p.flagged}</a>` : '<span class="muted">0</span>'}</td>
		<td>${p.synced_at ? esc(ago(p.synced_at)) : '<span class="muted">never</span>'}</td>
	</tr>`).join('') || `<tr><td colspan="6" class="muted">${everyone.length ? 'No one matches.' : 'No one has signed in yet.'}</td></tr>`
	$('people-count').textContent = `${list.length < everyone.length ? `${num(list.length)} of ` : ''}${plural(everyone.length, 'person', 'people')}`
	labelCells(view)
	return list
}

async function people() {
	everyone = (await api('/people')).people
	afterDraw = drawPeople
	return head('People', `<span class="status" id="people-count"></span>${lookup()}`) + `<div class="panel">
		<div class="people-tools">
			<label class="check"><input type="checkbox" data-people="synced"${listing.synced ? ' checked' : ''}>Only people who have synced</label>
			<label>Order<select data-people="by">${Object.entries(ORDERS).map(([by, [name]]) => `<option value="${by}"${by === listing.by ? ' selected' : ''}>${name}</option>`).join('')}</select></label>
		</div>
		<div class="table-scroll"><table class="data people stack">
			<thead><tr><th>Name</th><th>Slack ID</th><th>Engaged, past year</th><th>Computers</th><th>Flagged</th><th>Last sync</th></tr></thead>
			<tbody id="people-rows"></tbody>
		</table></div>
	</div>
	<p class="muted fine">Choose a person to read their computers, their projects, and every report they sent. Typing a name or Slack ID in the box above narrows the list.</p>`
}

// ---- One person

function projectTable(projects) {
	if (!projects.length) return '<p class="muted">No project has time yet.</p>'
	const total = projects.reduce((sum, p) => sum + p.engaged_seconds, 0)
	return `<div class="table-scroll"><table class="data left stack">
		<tr><th>Project</th><th>Share</th><th>Engaged, past year</th></tr>
		${projects.map((p) => `<tr><td>${esc(p.name)}</td><td>${Math.round((100 * p.engaged_seconds) / total)}%</td><td>${dur(p.engaged_seconds)}</td></tr>`).join('')}
	</table></div>`
}

// ---- Project activity: graphs drawn from a project's work blocks

// A block, as the server sends it.
const B = { start: 0, end: 1, engaged: 2, prompts: 3, tin: 4, tout: 5, added: 6, removed: 7, kept: 8, computer: 9 }
const HOUR = 3600_000
const DAY_MS = 86400_000
const localDay = (ms) => {
	const d = new Date(ms)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// dayAt is the reviewer's midnight starting a YYYY-MM-DD day, k days on.
const dayAt = (day, k = 0) => {
	const [y, m, d] = day.split('-').map(Number)
	return new Date(y, m - 1, d + k).getTime()
}
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '')
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : num(n))
// perLocalDay adds up engaged time by day in the reviewer's time zone. A block
// that runs past midnight is split, its engaged time spread over its length.
function perLocalDay(blocks) {
	const per = new Map()
	for (const b of blocks) {
		const span = b[B.end] - b[B.start]
		for (let t = b[B.start]; ; ) {
			const next = Math.min(b[B.end], new Date(t).setHours(24, 0, 0, 0))
			const day = localDay(t)
			per.set(day, (per.get(day) ?? 0) + (span ? (b[B.engaged] * (next - t)) / span : b[B.engaged]))
			if (next >= b[B.end]) break
			t = next
		}
	}
	return per
}

// checks looks for what a reviewer should ask about in one project's blocks.
// Each check says what it found, and whether that is worth a look.
function checks(blocks) {
	const out = []
	// Time on this project counted on two computers at once: while k computers
	// are working at the same moment, k - 1 of them count it again.
	let overlap = 0
	const edges = []
	for (const b of blocks) edges.push([b[B.start], 1, b[B.computer]], [b[B.end], -1, b[B.computer]])
	edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
	const working = new Map()
	let last = 0
	for (const [at, step, c] of edges) {
		if (working.size > 1) overlap += (working.size - 1) * (at - last)
		last = at
		const n = (working.get(c) ?? 0) + step
		if (n > 0) working.set(c, n)
		else working.delete(c)
	}
	out.push(overlap > 15 * 60_000
		? ['bad', `${dur(overlap / 1000)} was worked on two computers at the same time.`, 'Both computers count it, so the total holds it twice.']
		: ['ok', 'No time counted on two computers at once.'])
	// Long stretches with attention on almost every minute.
	const steady = blocks.filter((b) => b[B.end] - b[B.start] > 4 * HOUR && b[B.engaged] / ((b[B.end] - b[B.start]) / 1000) > 0.9)
	out.push(steady.length
		? ['bad', `${plural(steady.length, 'block')} of over 4 hours engaged for more than 90% of it.`, 'People take breaks. Look at these on the scatter below.']
		: ['ok', 'No long blocks without breaks.'])
	// Code that changed without anyone asking for it.
	const silent = blocks.filter((b) => b[B.added] + b[B.removed] > 0 && b[B.prompts] === 0)
	out.push(silent.length
		? ['warn', `${plural(silent.length, 'block')} changed lines without a single prompt.`, 'Could be hand-written code, or lines pasted in.']
		: ['ok', 'Every block that changed lines had prompts.'])
	// Many lines for little time.
	const engaged = blocks.reduce((s, b) => s + b[B.engaged], 0)
	const added = blocks.reduce((s, b) => s + b[B.added], 0)
	const pace = engaged ? added / (engaged / 3600) : 0
	out.push(pace > 1500
		? ['warn', `${num(Math.round(pace))} lines added per engaged hour.`, 'High even for an agent. Generated or vendored files can do this.']
		: ['ok', `${num(Math.round(pace))} lines added per engaged hour.`])
	// Days that are too long to be real.
	const long = [...perLocalDay(blocks)].filter(([, s]) => s > 14 * 3600)
	out.push(long.length
		? ['bad', `${plural(long.length, 'day')} with over 14 hours on this project, by your time zone's days.`, long.slice(0, 3).map(([d, s]) => `${dayName(d)}: ${dur(s)}`).join(', ')]
		: ['ok', 'No day over 14 hours.'])
	return out
}

// punchCard draws when in the week they work: a dot per weekday and hour,
// larger for more engaged time, from the whole year. Hours are the reviewer's.
function punchCard(blocks) {
	const grid = Array.from({ length: 7 }, () => new Array(24).fill(0))
	for (const b of blocks) {
		const span = b[B.end] - b[B.start]
		if (!span) continue
		// The engaged time is spread over the hours the block covered.
		for (let t = b[B.start]; t < b[B.end]; ) {
			const d = new Date(t)
			const next = Math.min(b[B.end], new Date(d).setMinutes(60, 0, 0))
			grid[(d.getDay() + 6) % 7][d.getHours()] += (b[B.engaged] * (next - t)) / span
			t = next
		}
	}
	const top = Math.max(1, ...grid.flat())
	const W = 720, cw = (W - 40) / 24, rh = 22
	const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
	let dots = ''
	grid.forEach((row, r) => {
		dots += `<text x="0" y="${r * rh + 15}">${names[r]}</text>`
		row.forEach((s, h) => {
			const radius = s ? 1.5 + 8 * Math.sqrt(s / top) : 1
			dots += `<circle class="${s ? (h < 6 ? 'night' : 'dot') : 'none'}" cx="${(40 + h * cw + cw / 2).toFixed(1)}" cy="${r * rh + 11}" r="${radius.toFixed(1)}"><title>${names[r]} ${String(h).padStart(2, '0')}:00: ${s ? dur(s) : 'nothing'}</title></circle>`
		})
	})
	const hours = [0, 6, 12, 18, 23].map((h) => `<text x="${(40 + h * cw + cw / 2).toFixed(1)}" y="${7 * rh + 12}" text-anchor="middle">${String(h).padStart(2, '0')}</text>`).join('')
	return `<svg class="chart" viewBox="0 0 ${W} ${7 * rh + 16}" role="img" aria-label="Engaged time by weekday and hour">${dots}${hours}</svg>`
}

// blockScatter puts each block at its length across, and the share of it
// that was engaged up. Long blocks near the top had no breaks.
function blockScatter(blocks) {
	const W = 720, H = 200, left = 34, bottom = 20, most = 8 * 3600
	const dots = blocks.map((b) => {
		const wall = (b[B.end] - b[B.start]) / 1000
		const share = wall ? Math.min(1, b[B.engaged] / wall) : 1
		const x = left + (Math.min(wall, most) / most) * (W - left - 8)
		const y = 6 + (1 - share) * (H - bottom - 12)
		const odd = wall > 4 * 3600 && share > 0.9
		return `<circle class="${odd ? 'odd' : 'dot'}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${odd ? 5 : 3.5}"><title>${esc(when(b[B.start]))}: ${dur(wall)} long, ${dur(b[B.engaged])} engaged (${Math.round(share * 100)}%), ${plural(b[B.prompts], 'prompt')}, ${num(b[B.added])} lines added</title></circle>`
	}).join('')
	const axis = [0, 2, 4, 6, 8].map((h) => `<text x="${left + (h / 8) * (W - left - 8)}" y="${H - 4}" text-anchor="middle">${h}h${h === 8 ? '+' : ''}</text>`).join('') +
		['100%', '50%', '0%'].map((t, i) => `<text x="0" y="${10 + i * ((H - bottom - 12) / 2)}">${t}</text>`).join('')
	const zone = `<rect class="zone" x="${left + 0.5 * (W - left - 8)}" y="6" width="${0.5 * (W - left - 8)}" height="${0.1 * (H - bottom - 12)}"/>`
	return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Each block's length and how much of it was engaged">${zone}${axis}${dots}</svg>`
}

// ---- One project: every series on one time axis
//
// The chart draws what a project's blocks and commits hold, each series as
// a share of its own total, so their shapes line up and any can be laid over
// any other. Where one climbs and the others stay flat is worth a question.
// Below it, the same series per day. Lightweight Charts by TradingView draws
// them (vendor/, Apache 2.0). Its license asks for its notice and a link to
// tradingview.com on the page: the line under the chart is that, in place of
// the logo, which sat over the bars.

const SERIES = [
	{ id: 'added', name: 'Lines added', color: 'accent', on: true },
	{ id: 'removed', name: 'Lines removed', color: 'bad' },
	{ id: 'kept', name: 'Lines kept', color: 'good' },
	{ id: 'committed', name: 'Lines committed', color: 'important', on: true },
	{ id: 'engaged', name: 'Engaged time', color: 'warn', on: true },
	{ id: 'prompts', name: 'Prompts', color: 'pink', on: true },
	{ id: 'tokens', name: 'Tokens written', color: 'teal' },
]
const PALETTE = { pink: '#f472b6', teal: '#2dd4bf' }
const SHOWN = 'teardrop-review-series'
// Which series are on, for whoever chose them.
let shown = new Set(SERIES.filter((s) => s.on).map((s) => s.id))
try {
	const saved = JSON.parse(localStorage.getItem(SHOWN) ?? 'null')
	if (Array.isArray(saved)) shown = new Set(saved)
} catch {}
const fmt = (id, v) => (id === 'engaged' ? dur(v) : num(Math.round(v)))
// The charts' clock is UTC, so times move by the reviewer's offset to read as theirs.
const localSec = (ms) => Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60

// series works out, for one project, each series' amount and running total
// in every step of time from its first moment to its last: a day, or an hour
// for a project shorter than ten days. Every step gets a point, quiet ones
// too, so the chart's evenly spaced points are evenly spaced in time.
function series(p) {
	const at = new Map()
	const put = (ms, id, v) => {
		if (!v) return
		const t = localSec(ms)
		const row = at.get(t) ?? {}
		row[id] = (row[id] ?? 0) + v
		at.set(t, row)
	}
	for (const b of p.blocks) {
		put(b[B.start], 'added', b[B.added])
		put(b[B.start], 'removed', b[B.removed])
		put(b[B.start], 'kept', b[B.kept])
		put(b[B.start], 'engaged', b[B.engaged])
		put(b[B.start], 'prompts', b[B.prompts])
		put(b[B.start], 'tokens', b[B.tout])
	}
	for (const c of p.commits ?? []) put(c.t, 'committed', c.added)
	const moments = [...at.keys()]
	const first = Math.min(...moments), last = Math.max(...moments)
	const step = last - first > 10 * 86400 ? 86400 : 3600
	const slot = (t) => Math.floor(t / step) * step
	const steps = new Map()
	if (moments.length) for (let t = slot(first); t <= last; t += step) steps.set(t, {})
	for (const [t, row] of at) {
		const into = steps.get(slot(t))
		for (const id in row) into[id] = (into[id] ?? 0) + row[id]
	}
	const times = [...steps.keys()]
	const total = Object.fromEntries(SERIES.map(({ id }) => [id, times.reduce((n, t) => n + (steps.get(t)[id] ?? 0), 0)]))
	const run = Object.fromEntries(SERIES.map(({ id }) => [id, []]))
	const sums = Object.fromEntries(SERIES.map(({ id }) => [id, 0]))
	for (const t of times) for (const { id } of SERIES) run[id].push((sums[id] += steps.get(t)[id] ?? 0))
	return { times, step, slot, unit: step === 3600 ? 'hour' : 'day', days: times.map((t) => [t, steps.get(t)]), total, run }
}

// spark is a card's small picture: lines added, engaged time, and lines
// committed, each as a share of its total, over the project's life.
function spark(p) {
	const W = 260, H = 56
	const s = series(p)
	if (s.times.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}"></svg>`
	const t0 = s.times[0], t1 = s.times.at(-1)
	const path = (id) => s.total[id] ? `<path class="s-${id}" d="${s.times.map((t, i) => `${i ? 'L' : 'M'}${(((t - t0) / (t1 - t0)) * (W - 4) + 2).toFixed(1)},${(H - 3 - (s.run[id][i] / s.total[id]) * (H - 6)).toFixed(1)}`).join('')}"/>` : ''
	return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${path('engaged')}${path('committed')}${path('added')}</svg>`
}

// projectCards lists a person's projects, each a link to its own page.
function projectCards(projects, base, c) {
	if (!projects.length) return '<div class="panel"><p class="muted">No work blocks yet. Their computers have synced none, or synced before blocks were kept.</p></div>'
	const shown = projects.map((p, i) => [c.cropped ? cropBlocks(p, c) : p, i]).filter(([p]) => !c.cropped || p.blocks.length || p.commits.length)
	if (!shown.length) return '<div class="panel"><p class="muted">No project has work on these days.</p></div>'
	return `<section class="pcards">${shown.map(([p, i]) => {
		const sum = (k) => p.blocks.reduce((s, b) => s + b[k], 0)
		if (c.cropped) p.engaged_seconds = sum(B.engaged)
		return `<a class="pcard" href="${base}/p/${i}${c.query}">
			<div class="pcard-top"><b>${esc(p.name)}</b><small>${esc(longDate(p.blocks.at(-1)?.[B.end] ?? Date.now()))}</small></div>
			${spark(p)}
			<div class="pcard-nums"><span>${dur(p.engaged_seconds)}</span><span>+${compact(sum(B.added))} lines</span><span>${plural(sum(B.prompts), 'prompt')}</span><span>${plural(p.commits?.length ?? 0, 'commit')}</span></div>
		</a>`
	}).join('')}</section>`
}

// ---- Crops: a stretch of time in the address, ?from=…&to=…
//
// Person and project pages crop to whole days (YYYY-MM-DD), a submission to
// minutes (YYYY-MM-DDTHH:MM), in the reviewer's time zone. Both ends are
// included, and either may be left open.
const isMinute = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s ?? '')
const localMinute = (ms) => {
	const d = new Date(ms)
	return `${localDay(ms)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function readCrop(query, kind) {
	const q = new URLSearchParams(query)
	const ok = kind === 'date' ? isDay : isMinute
	let from = ok(q.get('from')) ? q.get('from') : '', to = ok(q.get('to')) ? q.get('to') : ''
	if (from && to && from > to) [from, to] = [to, from]
	const at = (v, end) => (kind === 'date' ? dayAt(v, end ? 1 : 0) : new Date(v).getTime() + (end ? 60_000 : 0))
	const lo = from ? at(from, false) : -Infinity, hi = to ? at(to, true) : Infinity
	const query2 = new URLSearchParams({ ...(from && { from }), ...(to && { to }) }).toString()
	return { kind, from, to, lo, hi, cropped: Boolean(from || to), query: query2 ? '?' + query2 : '' }
}
// cropBlocks keeps a project's blocks that touch the crop and its commits made in it.
const cropBlocks = (p, c) => ({ ...p, blocks: p.blocks.filter((b) => b[B.end] > c.lo && b[B.start] < c.hi), commits: (p.commits ?? []).filter((x) => x.t >= c.lo && x.t < c.hi), cropped: c.cropped })
// cropBar draws the crop's controls for a page whose data runs from first to
// last, in the crop's own units. extra is more buttons; whole names the page.
function cropBar(here, c, first, last, note, extra, whole) {
	const unit = c.kind === 'date' ? 'days' : 'stretch of time'
	return `<form class="rv-form pcrop" data-form="crop" data-here="${esc(here)}" data-kind="${c.kind}" data-first="${first}" data-last="${last}">
		<label>From<input type="${c.kind}" name="from" value="${c.from}" min="${first}" max="${last}"></label>
		<label>To<input type="${c.kind}" name="to" value="${c.to}" min="${first}" max="${last}"></label>
		<div class="pcrop-btns">
			<button class="btn small" type="button" data-crop="earlier" title="The same ${unit}, just before" aria-label="Earlier">◀</button>
			<button class="btn small" type="button" data-crop="later" title="The same ${unit}, just after" aria-label="Later">▶</button>
			${extra}
			${c.cropped ? `<button class="btn small" type="button" data-crop="all">${whole}</button>` : ''}
		</div>
		<span class="pcrop-note${c.cropped ? ' on' : ''}">${note}</span>
	</form>`
}
const dayButtons = (what) => [1, 7, 30].map((n) => `<button class="btn small" type="button" data-crop="${n}" title="The last ${n === 1 ? 'day' : `${n} days`} of the crop, or of ${what}">${n}d</button>`).join('')
// spanOf is the first and last day a person's or project's blocks and commits touch.
function spanOf(projects) {
	const moments = projects.flatMap((p) => [...p.blocks.flatMap((b) => [b[B.start], b[B.end]]), ...(p.commits ?? []).map((c) => c.t)])
	return moments.length ? [localDay(Math.min(...moments)), localDay(Math.max(...moments))] : null
}

// projectPage is one project, alone: its numbers, the chart, its checks, and
// its commits. A crop narrows all of them to the blocks that touch its days
// and the commits made in them.
function projectPage(name, back, whole, here, query) {
	const c = readCrop(query, 'date')
	const p = cropBlocks(whole, c)
	const { cropped } = p
	const span = spanOf([whole])
	const note = cropped
		? p.blocks.length || p.commits.length
			? `${plural(p.blocks.length, 'block')} of ${num(whole.blocks.length)}, ${plural(p.commits.length, 'commit')} of ${num(whole.commits?.length ?? 0)}`
			: 'Nothing on these days.'
		: 'The whole project.'
	const crop = span ? cropBar(here, c, ...span, note, dayButtons('the project') + '<button class="btn small" type="button" data-crop="view" title="The days the chart shows now, after scrolling to zoom">Crop to chart</button>', 'Whole project') : ''
	const bl = p.blocks
	const sum = (i) => bl.reduce((s, b) => s + b[i], 0)
	const commits = [...(p.commits ?? [])].sort((a, b) => b.t - a.t)
	const found = commits.filter((c) => c.found === true).length, missing = commits.filter((c) => c.found === false).length
	const repo = /^github\.com\//.test(p.key ?? '') ? 'https://' + p.key : ''
	const { total } = series(p)
	afterDraw = () => drawProject(p)
	return `<div class="review project">
		<nav class="crumbs"><a href="${back}${c.query}">${esc(name)}</a><span>/</span><b>${esc(p.name)}</b></nav>
		${head(esc(p.name), p.key && p.key !== p.name ? `<span class="status"><code>${esc(p.key)}</code></span>` : '')}
		${crop}
		<div class="act-facts">${[
			['Engaged', dur(sum(B.engaged))],
			['Blocks', num(bl.length)],
			['Prompts', num(sum(B.prompts))],
			['Lines', `+${compact(sum(B.added))} -${compact(sum(B.removed))}<small>${compact(sum(B.kept))} kept</small>`],
			['Commits', `${num(commits.length)}<small>${commits.length ? `${num(found)} found on the host${missing ? `, ${num(missing)} not` : ''}` : 'none reported'}</small>`],
			['Active', bl.length ? `${esc(longDate(bl[0][B.start]))}<small>to ${esc(longDate(bl.at(-1)[B.end]))}</small>` : '-'],
		].map(([k, x]) => `<div><span>${k}</span><b>${x}</b></div>`).join('')}</div>
		<div class="panel pchart-panel">
			<div class="pchips" role="group" aria-label="Series to draw">${SERIES.map((s) => `<button type="button" data-series="${s.id}" aria-pressed="${shown.has(s.id)}" style="--c: var(--s-${s.id})"${total[s.id] ? '' : ` class="empty" title="${cropped ? 'None on these days' : 'None in this project'}"`}><i></i>${s.name}${total[s.id] ? '' : ': none'}</button>`).join('')}</div>
			<div class="plegend" id="plegend"></div>
			<div class="pchart" id="pchart"></div>
			<p class="muted fine">Top: each series' running total, as a share of its own total, so their shapes line up. Bottom: the same per day, or per hour over less than 10 days. Times are in your time zone. Scroll to zoom, drag to pan, hover for numbers. The chart is drawn by <a href="https://www.tradingview.com/" rel="noopener" target="_blank">TradingView Lightweight Charts™</a>, copyright (c) 2025 TradingView, Inc.</p>
		</div>
		<ul class="act-checks">${checks(bl).map(([kind, text, more]) => `<li class="${kind}"><b>${esc(text)}</b>${more ? ` <span>${esc(more)}</span>` : ''}</li>`).join('')}</ul>
		<div class="act-grid">
			<figure><figcaption>When they work <small>weekday and hour in your time zone, orange before 6:00</small></figcaption>${punchCard(bl)}</figure>
			<figure><figcaption>Every block: length and share engaged <small>red: over 4 hours, engaged over 90%</small></figcaption>${blockScatter(bl)}</figure>
		</div>
		${commits.length ? `<div class="panel"><h2>Commits <small>newest first, the last ${commits.length} the site kept</small></h2><div class="table-scroll tall"><table class="data left stack">
			<tr><th>When</th><th>Lines</th><th>On the host</th>${commits[0].sha ? '<th>Commit</th>' : ''}</tr>
			${commits.map((c) => `<tr><td>${esc(when(c.t))}</td><td>+${num(c.added)} −${num(c.removed)}</td><td class="${c.found === false ? 'bad' : ''}">${c.found === true ? 'Found' : c.found === false ? 'Not found' : 'Not checked'}</td>${c.sha ? `<td>${repo ? `<a href="${esc(repo)}/commit/${esc(c.sha)}" rel="nofollow noopener" target="_blank"><code>${esc(c.sha.slice(0, 7))}</code></a>` : `<code>${esc(c.sha.slice(0, 7))}</code>`}</td>` : ''}</tr>`).join('')}
		</table></div></div>` : ''}
		<p class="muted fine">Drawn from the work blocks in each computer's latest report and the commits their computers reported. The numbers come from the person's own computers.</p>
	</div>`
}

// What the chart on the page draws, so the series buttons and the theme switch can reach it.
let drawn = null
// Which series the one lower pane shows on a phone.
let lone = ''

// drawProject draws the open project's chart into #pchart, over the stretch
// of time given, as a redraw keeps the reviewer's zoom.
function drawProject(p, range = null) {
	clearCharts()
	const el = $('pchart')
	if (!el || !window.LightweightCharts) return
	const LW = window.LightweightCharts
	const css = getComputedStyle(root)
	const v = (n) => css.getPropertyValue('--' + n).trim()
	const color = (c) => PALETTE[c] ?? v(c)
	for (const s of SERIES) el.closest('.panel').style.setProperty('--s-' + s.id, color(s.color))
	const s = series(p)
	const on = SERIES.filter(({ id }) => shown.has(id) && s.total[id])
	// A phone has room for one lower pane, not one per series: its strip is a
	// list to pick which series it shows.
	const narrow = el.clientWidth < 600
	const below = narrow ? on.filter(({ id }) => id === (on.some((x) => x.id === lone) ? lone : on[0].id)) : on
	// A pane of days or hours is a strip of HEAD for its name, then its bars.
	const TOP = 280, PANE = 108, HEAD = 28
	el.style.setProperty('--head', `${HEAD}px`)
	el.style.height = `${TOP + below.length * PANE + 30}px`
	const chart = LW.createChart(el, {
		autoSize: true,
		layout: { background: { type: 'solid', color: v('panel') }, textColor: v('muted'), fontFamily: v('sans'), fontSize: 12, attributionLogo: false, panes: { separatorColor: v('line'), separatorHoverColor: v('line-2') } },
		grid: { vertLines: { visible: false }, horzLines: { color: v('line') } },
		rightPriceScale: { borderVisible: false },
		timeScale: { borderColor: v('line'), timeVisible: s.step === 3600, rightOffset: 4 },
		crosshair: { mode: 0, vertLine: { color: v('line-2'), labelBackgroundColor: v('panel-2') }, horzLine: { color: v('line-2'), labelBackgroundColor: v('panel-2') } },
	})
	const pct = { type: 'custom', minMove: 0.1, formatter: (x) => `${Math.round(x)}%` }
	const whole = () => ({ priceRange: { minValue: 0, maxValue: 100 } })
	// The series turned on that have anything to draw: each a line on top, and its own pane of days below.
	drawn = { chart, p, s, line: {}, color: {} }
	on.forEach(({ id, color: c }) => {
		const line = chart.addSeries(LW.LineSeries, { color: color(c), lineWidth: 2, lineType: 1, priceFormat: pct, autoscaleInfoProvider: whole, lastValueVisible: false, priceLineVisible: false, crosshairMarkerRadius: 3 })
		line.setData(s.times.map((t, i) => ({ time: t, value: (100 * s.run[id][i]) / s.total[id] })))
		drawn.line[id] = line
		drawn.color[id] = color(c)
		const k = below.findIndex((x) => x.id === id)
		if (k < 0) return
		// The bars stop short of the pane's name. The name's strip hides a grid
		// line behind it, so the scale leaves that line's number out too.
		const clear = (base) => {
			const r = base()
			return r && { ...r, margins: { above: HEAD + 4, below: 0 } }
		}
		const bars = chart.addSeries(LW.HistogramSeries, { color: color(c), autoscaleInfoProvider: clear, lastValueVisible: false, priceLineVisible: false }, k + 1)
		const hidden = (x) => (bars.priceToCoordinate(x) ?? PANE) < HEAD
		// Engaged time is drawn in hours, so the scale's numbers land on whole hours and quarters, not odd minutes.
		const per = id === 'engaged' ? 3600 : 1
		bars.applyOptions({ priceFormat: { type: 'custom', minMove: per === 1 ? 1 : 0.25, formatter: (x) => (hidden(x) ? '' : fmt(id, x * per)) } })
		bars.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } })
		bars.setData(s.days.filter(([, d]) => d[id]).map(([t, d]) => ({ time: t, value: d[id] / per })))
	})
	// Each commit is a dot on the committed line, red when the host doesn't have it.
	if (drawn.line.committed) LW.createSeriesMarkers(drawn.line.committed, (p.commits ?? []).map((c) => ({ time: s.slot(localSec(c.t)), position: 'inBar', shape: 'circle', size: 0.3, color: c.found === false ? v('bad') : color('important') })).sort((a, b) => a.time - b.time))
	// The top pane gets TOP of the height and each day pane PANE, however wide the page is.
	const panes = chart.panes()
	panes[0]?.setStretchFactor(TOP)
	for (const pane of panes.slice(1)) pane.setStretchFactor(PANE)
	chart.priceScale('right', 0).applyOptions({ scaleMargins: { top: 0.06, bottom: 0.04 } })
	// Each lower pane is named in a strip across the top of its plot, put there
	// once the panes are laid out, and again when the plot changes width or
	// the reviewer drags a pane taller.
	el.insertAdjacentHTML('beforeend', below.map(({ id, name }) => narrow && on.length > 1
		? `<label class="plabel" style="--c: var(--s-${id})" hidden><i></i><select data-pane aria-label="Series this pane shows">${on.map((o) => `<option value="${o.id}"${o.id === id ? ' selected' : ''}>${o.name} per ${s.unit}</option>`).join('')}</select></label>`
		: `<span class="plabel" style="--c: var(--s-${id})" hidden><i></i>${name} per ${s.unit}</span>`).join(''))
	const labels = [...el.querySelectorAll('.plabel')]
	const place = () => {
		let top = 0
		panes.forEach((pane, k) => {
			if (k) {
				labels[k - 1].style.top = `${top}px`
				labels[k - 1].style.width = `${chart.timeScale().width()}px`
				labels[k - 1].hidden = false
			}
			top += pane.getHeight() + 1
		})
	}
	const later = () => drawn?.chart === chart && requestAnimationFrame(() => requestAnimationFrame(() => drawn?.chart === chart && place()))
	later()
	// A page that changes width past a phone's draws again, with the panes that width gets.
	chart.timeScale().subscribeSizeChange(() => (el.clientWidth < 600 !== narrow ? requestAnimationFrame(redraw) : later()))
	el.onpointermove = (e) => e.buttons && later()
	// On a phone, months of days are a solid fence: start on the last 45 steps.
	if (range) chart.timeScale().setVisibleLogicalRange(range)
	else if (narrow && s.times.length > 45) chart.timeScale().setVisibleLogicalRange({ from: s.times.length - 45, to: s.times.length + 2 })
	else chart.timeScale().fitContent()
	chart.subscribeCrosshairMove((param) => legend(param.time))
	legend()
}

// legend writes what the chart shows at a moment: each series' running total
// and share by then, and that day's amount. With no moment, the totals.
function legend(time) {
	const box = $('plegend')
	if (!box || !drawn) return
	const { s } = drawn
	// The last moment at or before the one pointed at.
	let i = s.times.length - 1
	if (time != null) {
		let lo = 0, hi = s.times.length - 1
		i = -1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (s.times[mid] <= time) (i = mid), (lo = mid + 1)
			else hi = mid - 1
		}
	}
	const dayStart = time == null ? null : s.days.findLast(([t]) => t <= time)
	const sameDay = dayStart && time - dayStart[0] < s.step ? dayStart[1] : null
	const label = time == null ? 'Totals' : new Date((time + new Date(time * 1000).getTimezoneOffset() * 60) * 1000).toLocaleString(undefined, s.step === 3600 ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })
	box.innerHTML = `<b>${esc(label)}</b>` + SERIES.filter(({ id }) => shown.has(id) && s.total[id]).map(({ id, name }) => {
		const so = i < 0 ? 0 : s.run[id][i]
		return `<span data-series="${id}" style="--c: var(--s-${id})"><i></i>${name} <b>${fmt(id, so)}</b>${time == null ? '' : `<small>${Math.round((100 * so) / s.total[id])}%${sameDay ? `, ${fmt(id, sameDay[id] ?? 0)} that ${s.unit}` : ''}</small>`}</span>`
	}).join('')
}

// focusSeries makes one series' line stand out while its button or legend
// entry is under the pointer, as the lines often lie on top of each other:
// it is drawn thicker and last, and the others fade. No id puts them back.
function focusSeries(id) {
	if (!drawn) return
	const one = id in drawn.line
	for (const [k, line] of Object.entries(drawn.line)) {
		const c = drawn.color[k]
		line.applyOptions({ color: one && k !== id && /^#[0-9a-f]{6}$/i.test(c) ? c + '40' : c, lineWidth: one && k === id ? 3 : 2 })
	}
	if (one) drawn.line[id].setSeriesOrder(drawn.chart.panes()[0].getSeries().length - 1)
}
view.addEventListener('pointerover', (e) => {
	const el = e.target.closest?.('.pchart-panel [data-series]')
	if (el) focusSeries(el.dataset.series)
})
view.addEventListener('pointerout', (e) => {
	if (e.target.closest?.('.pchart-panel [data-series]')) focusSeries('')
})

function clearCharts() {
	drawn?.chart.remove()
	drawn = null
	for (const el of document.querySelectorAll('.plabel')) el.remove()
}

// redraw draws the open project again, keeping the stretch of time in view.
const redraw = () => drawn && drawProject(drawn.p, drawn.chart.timeScale().getVisibleLogicalRange())

// The theme switch redraws the chart in the new colors.
new MutationObserver(redraw).observe(root, { attributes: true, attributeFilter: ['data-theme'] })

const banForm = (slack = '') => `<form class="rv-form" data-form="ban">
	${slack ? `<input type="hidden" name="slack_id" value="${esc(slack)}">` : '<label>Slack ID<input name="slack_id" placeholder="U012ABCDEF" autocomplete="off" spellcheck="false" required></label>'}
	<label class="grow">Reason, for reviewers only<input name="reason" maxlength="500" autocomplete="off" required></label>
	<button class="btn danger">Ban until lifted</button>
</form>
<p class="msg" role="alert" hidden></p>`

// ended says how a ban that is over ended: lifted by someone, or, for one
// from before bans lost their length, run out at the end it was given.
const ended = (b) => (b.lifted_by ? `. Lifted by ${named(b.lifted_by_name, b.lifted_by)}, ${esc(ago(b.lifted_at))}.` : `. It ran out ${esc(ago(b.lifted_at))}.`)

// banRow draws one ban. withName names the person and links to their account
// view, where bans are issued and lifted; canLift offers to lift one in force.
const banRow = (b, withName, canLift = false) => `<div class="item">
	<div class="grow">${withName ? `<a href="#/person/${encodeURIComponent(b.slack_id)}">${named(b.name, b.slack_id)}</a> ` : ''}<span class="badge${b.active ? ' banned' : ''}">${b.active ? 'Banned until lifted' : b.lifted_by ? 'Lifted' : 'Ran out'}</span>
		<div class="sub">${esc(b.reason)}</div>
		<div class="sub">By ${named(b.by_name, b.by_slack_id)}, ${esc(ago(b.at))}${b.active ? '.' : ended(b)}${b.active && b.was_until ? ` It was set to end ${esc(when(b.was_until))}, before bans lost their length; lift it then if that still stands.` : ''}</div>
	</div>
	${b.active && canLift ? `<button class="btn small" type="button" data-lift="${b.id}">Lift</button>` : ''}
</div>`

// accessPanel shows a person's place in the review app, and offers the
// changes the visitor may make to it, as the server reported them.
function accessPanel(slack, a) {
	const has = a.level == null ? '<p class="muted">No place in the review app.</p>' : `<p>${badge(a.level)} <span class="muted">They can ${CAN[a.level]}.</span></p>`
	const form = a.levels.length ? `<form class="rv-form" data-form="add">
		<input type="hidden" name="slack_id" value="${esc(slack)}">
		<label>${a.level == null ? 'Make them' : 'Change to'}<select name="level">${a.levels.map((l) => `<option value="${l}">${LEVELS[l]}</option>`).join('')}</select></label>
		<label class="grow">Note, for the others<input name="note" maxlength="200" autocomplete="off" placeholder="Optional"></label>
		<button class="btn primary">${a.level == null ? 'Add' : 'Change'}</button>
	</form>` : ''
	const remove = a.remove ? `<button class="btn small danger" type="button" data-remove="${esc(slack)}">Remove from the review app</button>` : ''
	const none = form || remove ? '' : `<p class="muted fine">${a.level === 0 ? 'Superadmins are set in the ADMINS variable, not here.' : 'You can change the access only of people below your own level.'}</p>`
	return `<div class="panel" data-area>
		<h2>Access</h2>
		${has}${form}${remove}${none}
		<p class="msg" role="alert" hidden></p>
	</div>`
}

// banPanel lists a person's bans, with the form to ban them when the visitor may.
function banPanel(slack, a, theirBans) {
	const form = !slack ? '<p class="muted">This account has no Slack ID, and bans go by Slack ID.</p>'
		: a.ban ? banForm(slack)
		: `<p class="muted fine">${a.level != null && a.level <= me.level ? 'You can ban only people below your own level.' : 'A superadmin issued their ban, so only a superadmin can change or lift it.'}</p>`
	return `<div class="panel" data-area>
		<h2>Bans</h2>
		${form}
		${theirBans.length ? `<div class="list">${theirBans.map((x) => banRow(x, false, a.lift)).join('')}</div>` : ''}
		${a.ban ? '' : '<p class="msg" role="alert" hidden></p>'}
	</div>`
}

// What a neoadmin or superadmin sees of a Slack ID that has never signed in:
// only their access and bans, so they can be added or banned before they arrive.
function unknownView(b) {
	const slack = b.person.slack_id
	const ban = b.bans.find((x) => x.active)
	return `<div class="review">
		<a class="back" href="#/people"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>All people</a>
		${head(`<code>${esc(slack)}</code>`, `<span class="status">Has not signed in yet</span>${ban ? '<span class="badge banned">Banned</span>' : ''}${lookup()}`)}
		${ban ? banBanner(ban) : ''}
		<div class="panels">${accessPanel(slack, b.access)}${banPanel(slack, b.access, b.bans)}</div>
		<p class="muted fine">No account has this Slack ID yet. What you set here holds from their first sign-in.</p>
	</div>`
}

// banBanner says, as loudly as the page can, that a person is banned, with
// the reason, which only reviewers see.
const banBanner = (ban) => `<div class="ban-banner" role="alert">
	<svg viewBox="0 0 16 16" width="30" height="30" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="m3.8 3.8 8.4 8.4"/></svg>
	<div><h2>Banned until lifted</h2><p>${esc(ban.reason)}</p><p class="fine">They are told they are banned, not why. Nothing new is taken from them.</p></div>
</div>`

// projectsSection leads a person's page: a card per project, each opening
// that project alone. Without work blocks, the synced totals stand in.
const projectsSection = (b) => `<h2 class="section">Projects <small>${b.activity.length ? `open one to review it<span class="spark-key"><i class="s-added"></i>lines added<i class="s-engaged"></i>engaged time<i class="s-committed"></i>lines committed</span>` : ''}</small></h2>` +
	(b.activity.length ? projectCards(b.activity, open.base, open.crop) : `<div class="panel">${projectTable(b.projects)}</div>`)

// personCrop is what a crop on a person's page changes: its bar, their
// engaged time and projects on those days from the work blocks, and which of
// the days that don't add up fall in it. The log and account aren't cropped.
function personCrop(b) {
	const c = open.crop
	const span = spanOf(b.activity ?? [])
	const kept = (b.activity ?? []).map((p) => cropBlocks(p, c)).filter((p) => p.blocks.length || p.commits.length)
	const engaged = kept.reduce((n, p) => n + p.blocks.reduce((s, x) => s + x[B.engaged], 0), 0)
	const days = (b.impossible_days ?? []).filter((d) => !c.cropped || (d.slice(0, 10) >= (c.from || '0') && d.slice(0, 10) <= (c.to || '9')))
	const note = c.cropped ? `${plural(kept.length, 'project')} with work on these days. The log isn't cropped.` : 'Everything they synced.'
	return { c, engaged, projects: kept.length, days, bar: span ? cropBar(open.base, c, ...span, note, dayButtons('their work'), 'Everything') : '' }
}

// What a reviewer sees of a person: who they are and each project's total.
function summaryView(b) {
	const p = b.person
	const name = personName(p)
	const k = personCrop(b)
	return `<div class="review">
		<a class="back" href="#/"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>Look up someone else</a>
		${head(esc(name), `<span class="status"><code>${esc(p.slack_id)}</code></span>${b.ban ? '<span class="badge banned">Banned</span>' : ''}`)}
		${b.ban ? banBanner(b.ban) : ''}
		${k.bar}
		<div class="stats">
			<div class="stat"><div class="label">Engaged, as synced</div><div class="value">${dur(k.c.cropped ? k.engaged : b.engaged_seconds)}</div><div class="hint">${k.c.cropped ? 'on these days, from work blocks' : 'in the past year'}</div></div>
			<div class="stat"><div class="label">Projects</div><div class="value">${k.c.cropped ? k.projects : b.projects.length}</div><div class="hint">${k.c.cropped ? 'with work on these days' : 'with time in the past year'}</div></div>
			<div class="stat"><div class="label">Last sync</div><div class="value">${b.synced_at ? esc(ago(b.synced_at)) : 'never'}</div><div class="hint">joined ${esc(longDate(p.created_at))}</div></div>
			<div class="stat"><div class="label">Flagged reports</div><div class="value${b.flagged_reports ? ' bad' : ''}">${b.flagged_reports}</div><div class="hint">${b.flagged_reports ? 'ask a neoadmin to read them' : 'nothing stood out'}</div></div>
		</div>
		${projectsSection(b)}
		<p class="muted fine">These totals come from the person's own computers, so they show activity and are not proof of it. Time on two computers at once counts for both.${p.deleted_at ? ' They deleted their account, so nothing more will arrive.' : ''}</p>
	</div>`
}

const X = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
const EVENTS = { sync: 'Sync', upload: 'File upload', remove: 'Computer removed', delete: 'Account deleted' }
const size = (bytes) => (bytes < 1024 ? `${bytes} bytes` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`)
const signed = (seconds) => `${seconds < 0 ? '-' : '+'}${dur(Math.abs(seconds))}`
// A date as the person's computer wrote it, which is in that computer's time zone.
const dayName = (date) => {
	const [y, m, d] = date.split('-').map(Number)
	return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

// changes draws the days or projects a report changed, or all it held.
function changes(title, first, rows, full, more = 0) {
	if (!rows?.length) return ''
	const top = full ? `<tr><th>${first}</th><th>Engaged</th></tr>` : `<tr><th>${first}</th><th>Before</th><th>Now</th><th>Change</th></tr>`
	const body = rows.map(([name, was, is]) => `<tr><td>${esc(first === 'Day' ? dayName(name) : name)}</td>` +
		(full ? `<td>${dur(is)}</td>` : `<td>${dur(was)}</td><td>${dur(is)}</td><td class="${is < was ? 'down' : 'up'}">${signed(is - was)}</td>`) + '</tr>').join('')
	return `<h4>${title} <small>${rows.length + more}</small></h4><div class="scrollbox"><table class="data mini">${top}${body}</table></div>` +
		(more ? `<p class="remark">And ${plural(more, 'more project')} with smaller changes.</p>` : '')
}

// entry draws one log row: what happened, what the server made of it, a link
// to the report itself when it is kept, and under Details what the server
// noted about it.
function entry(e) {
	const gone = e.event === 'remove' || e.event === 'delete'
	const state = e.refusal ? 'refused' : e.flagged ? 'flagged' : gone ? 'removed' : 'stored'
	const label = e.event === 'delete' ? 'Deleted' : { refused: 'Refused', flagged: 'Flagged', removed: 'Removed', stored: 'Stored' }[state]
	const compared = !e.refusal && !gone && e.prev_engaged_seconds != null && e.prev_since === e.since
	const change = compared ? e.engaged_seconds - e.prev_engaged_seconds : null
	const iso = (ms) => (ms == null ? 'unknown' : new Date(ms).toISOString())
	const d = e.detail
	const raw = [
		['arrived', iso(e.at)],
		['made', e.generated_at == null ? 'unknown' : `${iso(e.generated_at)}, ${dur((e.at - e.generated_at) / 1000)} before it arrived`],
		['window', e.since || 'unknown'],
		['total', `${num(e.engaged_seconds)}s (${dur(e.engaged_seconds)})`],
		['report before', e.prev_engaged_seconds == null ? 'none' : `${num(e.prev_engaged_seconds)}s (${dur(e.prev_engaged_seconds)}) over ${e.prev_since || 'unknown'}, made ${iso(e.prev_generated_at)}`],
		...(compared ? [['change', `${signed(change)} in the ${dur((e.at - e.prev_generated_at) / 1000)} since the report before`]] : []),
		['added to past days', e.past_added_seconds == null ? 'not compared' : `${num(e.past_added_seconds)}s (${dur(e.past_added_seconds)})`],
		['teardrop', (e.teardrop_version || 'unknown') + (e.prev_teardrop_version != null && e.prev_teardrop_version !== e.teardrop_version ? `, was ${e.prev_teardrop_version || 'unknown'}` : '')],
		...(d ? [
			['size', size(d.bytes)],
			['work blocks', d.blocks ? `${num(d.blocks)}, from ${iso(d.first_block)} to ${iso(d.last_block)}` : '0'],
			['days with time', num(d.active_days)],
			['projects', num(d.project_count)],
			['prompts', `${num(d.prompts)}, and ${num(d.skipped_prompts)} left out`],
			['tokens', `${num(d.tokens_in)} read, ${num(d.tokens_out)} written`],
			['lines', `${num(d.lines_added)} added, ${num(d.lines_removed)} removed, ${num(d.lines_kept)} kept`],
			['tools', d.tools.join(', ') || 'none named'],
		] : []),
	]
	// What the report held, at a glance.
	const held = d && !gone ? [
		plural(d.blocks, 'work block'),
		plural(d.prompts, 'prompt'),
		plural(d.tokens_in + d.tokens_out, 'token'),
		...(d.days ? [d.full ? plural(d.days.length, 'day') : `${plural(d.days.length, 'day')} changed`] : []),
		size(d.bytes),
	].join(' - ') : ''
	return `<li class="${state}${e.refusal && e.flagged ? ' flagged' : ''}">
		<div class="line">
			<span class="mark">${label}</span>
			<b>${EVENTS[e.event] ?? esc(e.event)}</b>
			${e.computer_id ? `<button type="button" class="link" data-computer="${esc(e.computer_id)}" title="Show only this computer's history"><code>${esc(e.computer_id)}</code></button>` : ''}
			<span class="num">${gone || (e.refusal && !e.engaged_seconds) ? '' : dur(e.engaged_seconds)}${change == null ? '' : ` <span class="muted">(${signed(change)})</span>`}</span>
			<time datetime="${iso(e.at)}" title="${esc(ago(e.at))}">${esc(exact(e.at))}</time>
		</div>
		${e.findings.map((f) => `<p class="finding">${esc(f)}</p>`).join('')}
		${e.refusal ? `<p class="${e.flagged ? 'finding' : 'remark'}">${esc(e.refusal)}</p>` : ''}
		${e.remarks.map((r) => `<p class="remark">${esc(r)}</p>`).join('')}
		${held || e.has_report ? `<p class="held">${held}${e.has_report ? `${held ? ' - ' : ''}<a href="/api/review/report?entry=${e.id}" target="_blank" rel="noopener" title="This report exactly as it arrived, with every work block">Full report</a>` : ''}</p>` : ''}
		<details><summary>Details</summary>
			<dl>${raw.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
			${d ? changes(d.full ? 'Every day in this report' : 'Days that changed', 'Day', d.days, d.full) : ''}
			${d ? changes(d.full ? 'Every project in this report' : 'Projects that changed', 'Project', d.projects, d.full, d.more_projects) : ''}
			${d && !d.full && d.days && !d.days.length ? '<p class="remark">No day changed since the report before.</p>' : ''}
		</details>
	</li>`
}

// Which person is open, and how their log is narrowed.
let open = { who: '', show: '', computer: '' }
const personPath = (before) => `/person?${open.who}${open.show ? `&show=${open.show}` : ''}${open.computer ? `&computer=${encodeURIComponent(open.computer)}` : ''}${before ? `&before=${before}` : ''}`

// What a neoadmin or superadmin sees of a person: everything.
function fullView(b) {
	const { person: p, computers, counts } = b
	const name = personName(p)
	const engaged = computers.reduce((sum, c) => sum + c.engaged_seconds, 0)
	const ban = b.bans.find((x) => x.active)
	const banned = Boolean(ban)
	const k = personCrop(b)
	const days = k.days
	const facts = [
		['Name', esc(name)],
		['Slack ID', p.slack_id ? `<code>${esc(p.slack_id)}</code>` : 'None'],
		['Joined', esc(longDate(p.created_at))],
		['Account', `#${p.id}`],
		...(p.deleted_at ? [['Deleted', esc(longDate(p.deleted_at)) + '. Its log is kept.']] : []),
	]
	const none = open.show ? `No ${open.show} entries${open.computer ? ' for this computer' : ''}.` : open.computer ? 'No entries for this computer.' : 'Nothing yet. Entries appear from the first sync after this log was added.'
	return `<div class="review">
		<a class="back" href="#/people"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>All people</a>
		${head(esc(name), `<span class="status">${p.slack_id ? `<code>${esc(p.slack_id)}</code>` : 'No Slack ID'}</span>${banned ? '<span class="badge banned">Banned</span>' : ''}${lookup()}`)}
		${ban ? banBanner(ban) : ''}
		${k.bar}
		<div class="stats">
			<div class="stat"><div class="label">Engaged, as synced</div><div class="value">${dur(k.c.cropped ? k.engaged : engaged)}</div><div class="hint">${k.c.cropped ? 'on these days, from work blocks' : computers.length === 1 ? 'from 1 computer' : `from ${computers.length} computers`}</div></div>
			<div class="stat"><div class="label">Not checkable</div><div class="value">${dur(b.unchecked_seconds)}</div><div class="hint">earlier history from first syncs</div></div>
			<div class="stat"><div class="label">Flagged reports</div><div class="value${counts.flagged ? ' bad' : ''}">${counts.flagged}</div><div class="hint">${counts.flagged ? 'read these first' : 'nothing stood out'}</div></div>
			<div class="stat"><div class="label">Refused reports</div><div class="value">${counts.refused}</div><div class="hint">of ${counts.entries} log entries</div></div>
		</div>
		${days.length ? `<div class="panel attention"><h2>Days that don't add up <small>${num(days.length)}</small></h2><ul>${days.slice(0, 5).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>${days.length > 5 ? `<details><summary>${plural(days.length - 5, 'more day')}</summary><ul>${days.slice(5).map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}</div>` : ''}
		${projectsSection(b)}
		<h2 class="section">Account and log</h2>
		<div class="panels">
			<div class="panel">
				<h2>Account</h2>
				<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
				${p.deleted_at ? '' : `<a class="btn small" href="/dashboard?user=${p.id}">Open their dashboard</a>`}
			</div>
			<div class="panel">
				<h2>Computers</h2>
				<div class="table-scroll"><table class="data stack">
					<tr><th>Computer</th><th>Engaged</th><th>Version</th><th>Last sync</th><th></th></tr>
					${computers.map((c) => `<tr${c.id === open.computer ? ' class="sel"' : ''}><td><code>${esc(c.id)}</code></td><td>${dur(c.engaged_seconds)}</td>
						<td>${esc(c.teardrop_version || 'unknown')}</td><td title="${esc(exact(c.synced_at))}">${esc(ago(c.synced_at))}</td>
						<td class="acts"><button type="button" class="link" data-computer="${esc(c.id)}">History</button><a href="/api/review/report?computer=${encodeURIComponent(c.id)}" target="_blank" rel="noopener" title="Its latest report in full, with every work block">Full report</a></td></tr>`).join('') ||
					`<tr><td colspan="5" class="muted">${p.deleted_at ? 'None. They deleted their account.' : 'None. They have signed in, but nothing has synced.'}</td></tr>`}
				</table></div>
			</div>
			${p.slack_id ? accessPanel(p.slack_id, b.access) : ''}
			${banPanel(p.slack_id, b.access ?? { ban: false, lift: false }, b.bans)}
			<div class="panel wide" id="log-panel">
				<div class="log-head">
					<h2>Log</h2>
					${open.computer ? `<button type="button" class="chip" data-computer="" title="Show every computer">History of ${esc(open.computer)}${X}</button>` : ''}
					<a class="btn small" id="download" href="/api/review/log?${open.who}" title="Every entry, with all of its details, as one JSON file">Download log</a>
					<div class="seg" role="group" aria-label="Which entries">
						${[['', 'All'], ['flagged', 'Flagged'], ['refused', 'Refused']].map(([value, label]) => `<button type="button" data-show="${value}" aria-pressed="${open.show === value}">${label}</button>`).join('')}
					</div>
				</div>
				<ol class="log" id="log">${b.log.map(entry).join('') || `<li class="none muted">${none}</li>`}</ol>
				<button class="btn small" id="more" data-before="${b.more ?? ''}"${b.more ? '' : ' hidden'}>Show older entries</button>
			</div>
		</div>
		<p class="muted fine">Each entry is one report from one of their computers. Details shows what the server noted about it, and Full report opens the report itself, exactly as it arrived, with every work block. Reports hold counts and times, not what was typed: the chats themselves arrive only with a project submission. Synced numbers come from the person's own computer, so they show activity and are not proof of it. A flag means a report can't be squared with the one before it: read it, then ask.</p>
	</div>`
}

// person draws #/person/<who>, or with /p/<n> one of their projects alone.
async function person(arg) {
	const [path, query = ''] = arg.split('?')
	const [whoArg, project] = path.split('/p/')
	const who = whoArg.startsWith('id:') ? `id=${encodeURIComponent(whoArg.slice(3))}` : `slack=${encodeURIComponent(whoArg)}`
	if (open.who !== who) open = { who, show: '', computer: '' }
	open.base = '#/person/' + encodeURIComponent(whoArg).replace('%3A', ':')
	let body
	try {
		body = await api(personPath())
	} catch (e) {
		return head('No one found', lookup()) + notice('No one found', e.message)
	}
	const one = project != null && body.activity?.[Number(project)]
	if (one) return projectPage(personName(body.person), open.base, one, `${open.base}/p/${project}`, query)
	open.crop = readCrop(query, 'date')
	return body.limited ? summaryView(body) : body.signed_in ? fullView(body) : unknownView(body)
}

// ---- Reviewers

async function team() {
	const t = await api('/team')
	const row = (r) => `<div class="item">
		<div class="grow"><a href="#/person/${encodeURIComponent(r.slack_id)}">${named(r.name, r.slack_id)}</a>${r.banned ? ' <span class="badge banned">Banned</span>' : ''}
			<div class="sub">${r.name == null ? 'Has not signed in yet. ' : ''}Added by ${named(r.added_by_name, r.added_by)}, ${esc(ago(r.added_at))}${r.note ? `: ${esc(r.note)}` : ''}</div>
		</div>
	</div>`
	const list = (level, none) => t.reviewers.filter((r) => r.level === level).map(row).join('') || `<div class="item"><div class="grow muted">${none}</div></div>`
	const ACTIONS = { add: 'added', change: 'changed', remove: 'removed', ban: 'banned', unban: 'lifted the ban on', permanent: 'made permanent the ban on' }
	return head('Reviewers', lookup()) + `<div class="panel">
		<p class="muted">To add someone, change their level, or remove them, open their account: look them up above, or choose them below. In Slack: open their profile, choose ⋮, then Copy member ID. They don't need to have signed in before.</p>
		<h2>Superadmins ${badge(0)}</h2>
		<p class="muted">They can ${CAN[0]}. They are the Slack IDs in the Worker's <code>ADMINS</code> variable, which is changed in the Cloudflare dashboard and not here.</p>
		<div class="list">${t.superadmins.map((s) => `<div class="item"><div class="grow">${named(s.name, s.slack_id)}${s.name == null ? '<div class="sub">Has not signed in yet.</div>' : ''}</div></div>`).join('') || '<div class="item"><div class="grow muted">None. ADMINS is empty.</div></div>'}</div>
		<h2>Neoadmins ${badge(1)}</h2>
		<p class="muted">They can ${CAN[1]}. Only a superadmin can add or remove one.</p>
		<div class="list">${list(1, 'None yet.')}</div>
		<h2>Reviewers ${badge(2)}</h2>
		<p class="muted">They can ${CAN[2]}.</p>
		<div class="list">${list(2, 'None yet.')}</div>
	</div>
	<div class="panel">
		<h2>Changes</h2>
		${t.log.length ? `<div class="table-scroll"><table class="data left stack">
			<tr><th>Who</th><th>Did what</th><th>When</th></tr>
			${t.log.map((l) => `<tr><td>${named(l.by_name, l.by_slack_id)}</td><td>${ACTIONS[l.action] ?? esc(l.action)} ${named(l.name, l.slack_id)}${l.detail ? ` <span class="muted">${esc(l.detail)}</span>` : ''}</td><td title="${esc(exact(l.at))}">${esc(ago(l.at))}</td></tr>`).join('')}
		</table></div>` : '<p class="muted">Nothing yet. Each reviewer added or removed, and each ban, is listed here.</p>'}
	</div>`
}

// ---- Bans

async function banList() {
	const { bans } = await api('/bans')
	const now = bans.filter((b) => b.active)
	const past = bans.filter((b) => !b.active)
	return head('Bans', lookup()) + `<div class="panel">
		<p class="muted">Every ban lasts until someone lifts it. While banned, nothing new is taken from the person: no syncs, uploads, cloud events, or submissions. They see that they are banned, but not the reason, which is for reviewers only. A banned reviewer can't review. To ban someone or lift a ban, open their account: look them up above, or choose them below. You can ban only people below your own level.</p>
	</div>
	<div class="panel">
		<h2>In force</h2>
		<div class="list">${now.slice(0, 5).map((b) => banRow(b, true)).join('') || '<div class="item"><div class="grow muted">No one is banned.</div></div>'}</div>
		${now.length > 5 ? `<details class="more"><summary>${plural(now.length - 5, 'more ban')} in force</summary><div class="list">${now.slice(5).map((b) => banRow(b, true)).join('')}</div></details>` : ''}
		${past.length ? `<details class="more"><summary>Over <small>${num(past.length)}</small></summary><div class="list">${past.map((b) => banRow(b, true)).join('')}</div></details>` : ''}
	</div>`
}

// ---- Submissions

async function submissionList() {
	const { submissions } = await api('/submissions')
	const rows = submissions.map((x) => `<tr>
		<td><a href="#/submission/${esc(x.id)}">${esc(x.project_name)}</a></td>
		<td>${me.level < 2 ? `<a href="#/person/id:${x.user_id}">${esc(x.name)}</a>` : esc(x.handle ? '@' + x.handle : '')}</td>
		<td>${esc(ago(x.received_at))}</td>
		<td>${dur(x.witnessed_seconds)}</td><td>${dur(x.unwitnessed_seconds)}</td>
		<td><b>${dur(x.credited_seconds + x.accepted_seconds)}</b></td>
		<td>${x.imported ? 'imported' : esc(x.state)}</td></tr>`)
	return head('Submissions') + `<div class="panel">
		<p class="muted">A submission is made on the site from the records it already holds. Only time whose records reached the site within 5 minutes of when they happened is credited, less what earlier submissions of the project covered. A neoadmin can accept unwitnessed time by hand, with a note.</p>
		<div class="table-scroll"><table class="data left stack">
			<tr><th>Project</th><th>Person</th><th>Received</th><th>Witnessed</th><th>Unwitnessed</th><th>Credited</th><th>State</th></tr>
			${rows.join('') || '<tr><td colspan="7" class="muted">No submissions yet.</td></tr>'}
		</table></div>
	</div>`
}

async function submissionPage(arg) {
	const [id, query = ''] = arg.split('?')
	const d = await api('/submissions/' + encodeURIComponent(id))
	const s = d.submission
	const all = d.records
	const spans = [...d.witnessed, ...d.unwitnessed]
	// A crop, to the minute, narrows the timeline and the records to its stretch.
	const c = readCrop(query, 'datetime-local')
	const moments = [...all.map((r) => r.t), ...spans.flat()]
	const lowest = moments.length ? Math.min(...moments) : s.received_at, highest = moments.length ? Math.max(...moments) : s.received_at
	const clip = (list) => list.map(([a, b]) => [Math.max(a, c.lo), Math.min(b, c.hi)]).filter(([a, b]) => b > a)
	const witnessed = clip(d.witnessed), unwitnessed = clip(d.unwitnessed)
	const recs = all.filter((r) => r.t >= c.lo && r.t < c.hi)
	// Uncropped, the bar spans the counted time, so a lone record hours away,
	// such as an old commit, doesn't squeeze the rest into a sliver. It is noted instead.
	const t0 = c.cropped ? Math.max(c.lo, lowest) : spans.length ? Math.min(...spans.map(([a]) => a)) : recs[0]?.t ?? s.received_at
	const t1 = Math.max(c.cropped ? Math.min(c.hi, highest) : spans.length ? Math.max(...spans.map(([, b]) => b)) : recs.at(-1)?.t ?? t0, t0 + 1)
	const outside = c.cropped ? 0 : recs.filter((r) => r.t < t0 || r.t > t1).length
	const secs = (list) => list.reduce((n, [a, b]) => n + (b - a) / 1000, 0)
	const note = c.cropped
		? `${plural(recs.length, 'record')} of ${num(all.length)}: ${dur(secs(witnessed))} witnessed, ${dur(secs(unwitnessed))} unwitnessed`
		: 'The whole submission. Drag across the timeline to crop it.'
	const crop = moments.length ? cropBar(`#/submission/${encodeURIComponent(id)}`, c, localMinute(lowest), localMinute(highest), note, '', 'Whole submission') : ''
	const x = (t) => (((t - t0) / (t1 - t0)) * 100).toFixed(3)
	const bars = (list, cls) => list.map(([a, b]) => `<span class="sub-span ${cls}" style="left:${x(a)}%;width:${Math.max(0.2, x(b) - x(a))}%"></span>`).join('')
	const marks = recs.filter((r) => r.t >= t0 && r.t <= t1).map((r) => `<span class="sub-mark${r.human ? ' human' : ''}${r.late_ms > 300000 ? ' late' : ''}" style="left:${x(r.t)}%" title="${esc(exact(r.t))} ${esc(r.tool)} ${esc(r.event)}"></span>`).join('')
	const late = (ms) => (ms <= 300000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `<b>${dur(Math.round(ms / 1000))}</b>`)
	const repoURL = me.level < 2 && /^github\.com\//.test(s.project_key ?? '') ? 'https://' + s.project_key : ''
	const event = (r) => (r.sha ? `commit ${repoURL ? `<a href="${esc(repoURL)}/commit/${esc(r.sha)}" rel="nofollow noopener">` : ''}<code>${esc(r.sha.slice(0, 7))}</code>${repoURL ? '</a>' : ''}` : esc(r.event))
	const rows = recs.map((r) => `<tr><td>${esc(exact(r.t))}</td><td>${late(r.late_ms)}</td><td>${esc(r.tool)}</td><td>${event(r)}</td><td>${esc(r.computer)}</td>
		<td>${r.human ? `${r.real ?? 0}/${r.judged ?? 0} words${r.low ? ', low effort' : ''}` : ''}</td><td>${r.in || r.out ? `${num(r.in ?? 0)} / ${num(r.out ?? 0)}` : ''}</td><td>${r.added || r.removed ? `+${r.added ?? 0} −${r.removed ?? 0}` : ''}</td></tr>`)
	const flags = d.flags.map((f) => `<li>${esc(f.text)}</li>`).join('')
	return head(esc(s.project_name), `<span class="status">${esc(s.id)}</span>`) + `
	<div class="panel">
		<div class="sub-stats">
			<div><span class="muted">Witnessed</span><b>${dur(s.witnessed_seconds)}</b></div>
			<div><span class="muted">Unwitnessed</span><b>${dur(s.unwitnessed_seconds)}</b></div>
			<div><span class="muted">In earlier submissions</span><b>${dur(s.earlier_overlap_seconds)}</b></div>
			<div><span class="muted">Credited</span><b>${dur(s.credited_seconds)}</b></div>
			<div><span class="muted">Accepted by hand</span><b>${dur(s.accepted_seconds)}</b></div>
			<div><span class="muted">Prompts</span><b>${num(s.prompts)}</b></div>
		</div>
		${me.level < 2 ? `<p class="muted">By <a href="#/person/id:${s.user_id}">${esc(s.name)}</a>, ${esc(s.project_key)}, received ${esc(when(s.received_at))}.</p>` : `<p class="muted">Received ${esc(when(s.received_at))}.</p>`}
		${s.submitter_note ? `<p>Their note: ${esc(s.submitter_note)}</p>` : ''}
		${s.note ? `<p>Accepted by ${esc(s.decided_by)}: ${esc(s.note)}</p>` : ''}
	</div>
	${flags ? `<div class="panel"><h2>Look at first</h2><ul>${flags}</ul></div>` : ''}
	<div class="panel">
		<h2>Timeline</h2>
		${crop}
		<div class="sub-line" data-t0="${t0}" data-t1="${t1}" title="Drag across to crop to that stretch">${bars(unwitnessed, 'unwitnessed')}${bars(witnessed, 'witnessed')}${marks}</div>
		<p class="muted fine">${esc(exact(t0))} to ${esc(exact(t1))}. Green is witnessed time, amber unwitnessed. Tall marks are prompts; red marks reached the site more than 5 minutes late.${outside ? ` ${plural(outside, 'record')} outside this stretch ${outside === 1 ? 'is' : 'are'} listed below but not drawn.` : ''}</p>
	</div>
	${me.level < 2 && s.unwitnessed_seconds > 0 ? `<div class="panel" data-area>
		<h2>Accept unwitnessed time</h2>
		<form class="rv-form" data-form="accept" data-id="${esc(s.id)}">
			<label>Seconds to accept, at most ${num(s.unwitnessed_seconds)} (${dur(s.unwitnessed_seconds)})<input name="seconds" type="number" min="0" max="${s.unwitnessed_seconds}" value="${s.accepted_seconds || s.unwitnessed_seconds}" required></label>
			<label class="grow">Why<input name="note" placeholder="Such as matching commits" required></label>
			<button class="btn">Accept</button>
		</form>
		<p class="msg" hidden></p>
	</div>` : ''}
	<div class="panel">
		<h2>Every record${c.cropped ? ` <small>${plural(recs.length, 'record')} in the crop, of ${num(all.length)}</small>` : ''}</h2>
		<div class="table-scroll tall"><table class="data left stack">
			<tr><th>When</th><th>Arrived after</th><th>Tool</th><th>Event</th><th>Computer</th><th>Prompt</th><th>Tokens in / out</th><th>Lines</th></tr>
			${rows.join('')}
		</table></div>
	</div>`
}

// ---- API keys

async function keyList() {
	const { keys } = await api('/keys')
	const all = [['GET /api/review/person?slack=U012ABCDEF', me.level === 2 ? "A person's total and work-block timeline for each project." : "Everything about a person: computers, projects, bans, and a page of their log. Also takes id, show, computer, and before."]]
	if (me.level < 2) all.push(
		['GET /api/review/people', 'Everyone with an account.'],
		['GET /api/review/log?slack=…', "A person's whole log."],
		['GET /api/review/report?entry=… or ?computer=…', 'One report in full, as it was signed.'],
		['GET /api/review/team', 'Who can review, and the changes to that.'],
		['POST /api/review/team', 'Add a reviewer: {"slack_id", "level", "note"}.'],
		['DELETE /api/review/team/U012ABCDEF', 'Remove a reviewer.'],
		['GET /api/review/bans', 'Every ban.'],
		['POST /api/review/bans', 'Ban someone until the ban is lifted: {"slack_id", "reason"}. A request with days is refused.'],
		['DELETE /api/review/bans/12', 'Lift a ban.'],
	)
	return head('API keys') + `<div class="panel" data-area>
		<h2>Make a key</h2>
		<p class="muted">A key lets a script or a bot call the review API as you. It can do what you can: as a ${LEVELS[me.level].toLowerCase()}, ${CAN[me.level]}. It follows you: if your level changes, so does what it can do, and it stops working if you are removed or banned.</p>
		<form class="rv-form" data-form="key">
			<label class="grow">What will use it<input name="name" maxlength="60" autocomplete="off" placeholder="Such as: review bot" required></label>
			<button class="btn primary">Make key</button>
		</form>
		<p class="msg" role="alert" hidden></p>
		<div class="list">${keys.map((k) => `<div class="item">
			<div class="grow"><b>${esc(k.name)}</b> <code>${esc(k.hint)}…</code>
				<div class="sub">Made ${esc(ago(k.created_at))} - ${k.last_used_at ? `last used ${esc(ago(k.last_used_at))}` : 'never used'}</div></div>
			<button class="btn small danger" type="button" data-revoke="${k.id}" data-name="${esc(k.name)}">Revoke</button>
		</div>`).join('') || '<div class="item"><div class="grow muted">You have no keys.</div></div>'}</div>
	</div>
	<div class="panel">
		<h2>Using a key</h2>
		<p class="muted">Send it as a bearer token. Answers are JSON, and a refusal is plain text with its reason.</p>
		<div class="cmdbox"><div class="cmd"><code>curl -H "Authorization: Bearer $KEY" "${esc(location.origin)}/api/review/person?slack=U012ABCDEF"</code><button class="copy" type="button">Copy</button></div></div>
		<div class="table-scroll"><table class="data left api">
			<tr><th>Call</th><th>What it does</th></tr>
			${all.map(([call, what]) => `<tr><td>${esc(call)}</td><td>${esc(what)}</td></tr>`).join('')}
		</table></div>
		<p class="muted fine">Keys are made and revoked here, signed in. A key can't make or revoke keys.</p>
	</div>`
}

// ---- Getting around

const ROUTES = { home, people, person, team, bans: banList, keys: keyList, submissions: submissionList, submission: submissionPage }
let turn = 0
// What a page draws once it is on screen, such as a project's chart.
let afterDraw = null

// route draws the page the address names, such as #/person/U012ABCDEF. An
// address that names no page, or one this visitor has none of, leads Home.
async function route() {
	const mine = ++turn
	const [name = '', ...rest] = location.hash.replace(/^#\/?/, '').split('/')
	const arg = decodeURIComponent(rest.join('/'))
	const page = !(name in ROUTES) || (name === 'people' && me.level === 2) || ((name === 'person' || name === 'submission') && !arg) ? 'home' : name
	// A person is under People for those who have the list, and under Home for a reviewer.
	const marked = page === 'submission' ? 'submissions' : page !== 'person' ? page : me.level === 2 ? 'home' : 'people'
	for (const a of document.querySelectorAll('.rv-nav a')) {
		if (a.dataset.page === marked) a.setAttribute('aria-current', 'page')
		else a.removeAttribute('aria-current')
	}
	let html
	afterDraw = null
	try {
		html = await ROUTES[page](arg)
	} catch (e) {
		html = notice('Could not load this', e.message)
	}
	if (mine !== turn) return
	document.body.dataset.page = page
	clearCharts()
	view.innerHTML = html
	labelCells(view)
	afterDraw?.()
	if (findWanted && page === 'home') {
		findWanted = false
		$('find')?.focus()
	}
}

// act carries out a change, then draws the page again. A refusal is shown
// beside what was pressed, in the server's own words.
async function act(el, change) {
	const msg = el.closest('[data-area]')?.querySelector('.msg')
	try {
		await change()
		await route()
	} catch (e) {
		if (msg) say(msg, e.message)
		else alert(e.message)
	}
}

view.addEventListener('submit', (e) => {
	const form = e.target.closest('[data-form]')
	if (!form) return
	e.preventDefault()
	const fields = Object.fromEntries(new FormData(form))
	const kind = form.dataset.form
	if (kind === 'crop') return cropTo(form, fields.from, fields.to)
	// A search box opens the person marked in its list, or the first one left
	// in People's table. A reviewer, or anyone before the list has loaded,
	// opens the Slack ID typed.
	if (kind === 'find') {
		const id = asSlackID(fields.q)
		const picked = me.level < 2 && (form.querySelector('[aria-selected="true"]') ?? view.querySelector('table.people tr[data-id] a'))
		const to = picked ? picked.getAttribute('href') : me.level === 2 || SLACK_ID.test(id) ? '#/person/' + encodeURIComponent(id) : ''
		if (to) location.hash = to
	}
	if (kind === 'add') act(form, () => send('POST', '/team', fields))
	if (kind === 'ban') act(form, () => send('POST', '/bans', fields))
	if (kind === 'accept') act(form, () => send('POST', `/submissions/${encodeURIComponent(form.dataset.id)}/accept`, { seconds: Number(fields.seconds), note: fields.note }))
	if (kind === 'key') {
		act(form, async () => {
			const made = await send('POST', '/keys', fields)
			$('key-value').textContent = made.key
			$('key-dialog').showModal()
		})
	}
})

view.addEventListener('click', async (e) => {
	const btn = e.target.closest('button')
	if (!btn) return
	const d = btn.dataset
	if ('remove' in d && confirm(`Remove ${d.remove} from the reviewers? Their API keys stop working too.`)) act(btn, () => send('DELETE', '/team/' + encodeURIComponent(d.remove)))
	if ('lift' in d && confirm('Lift this ban now?')) act(btn, () => send('DELETE', '/bans/' + d.lift))
	if ('revoke' in d && confirm(`Revoke the key "${d.name}"? Whatever uses it stops working at once.`)) act(btn, () => send('DELETE', '/keys/' + d.revoke))
	// A project chart's series, on or off, remembered for the next project.
	if ('series' in d && drawn) {
		const on = !shown.has(d.series)
		if (on) shown.add(d.series)
		else shown.delete(d.series)
		btn.setAttribute('aria-pressed', String(on))
		redraw()
		try {
			localStorage.setItem(SHOWN, JSON.stringify([...shown]))
		} catch {}
		return
	}
	// A project's crop: move it, size it, take the chart's view, or drop it.
	if ('crop' in d) {
		const form = btn.form, f = form.dataset
		const from = form.elements.from.value || f.first, to = form.elements.to.value || f.last
		if (f.kind !== 'date') {
			const a = new Date(from).getTime(), b = new Date(to).getTime(), len = b - a + 60_000
			if (d.crop === 'all') cropTo(form, '', '')
			else cropTo(form, localMinute(a + (d.crop === 'earlier' ? -len : len)), localMinute(b + (d.crop === 'earlier' ? -len : len)))
			return
		}
		const len = Math.round((dayAt(to) - dayAt(from)) / DAY_MS) + 1
		const shift = (k) => cropTo(form, localDay(dayAt(from, k)), localDay(dayAt(to, k)))
		if (d.crop === 'earlier') shift(-len)
		else if (d.crop === 'later') shift(len)
		else if (d.crop === 'all') cropTo(form, '', '')
		else if (d.crop === 'view') {
			if (!drawn?.s.times.length) return
			const { times } = drawn.s, r = drawn.chart.timeScale().getVisibleLogicalRange()
			const at = (i) => new Date(times[Math.min(times.length - 1, Math.max(0, i))] * 1000).toISOString().slice(0, 10)
			cropTo(form, at(Math.ceil(r.from)), at(Math.floor(r.to)))
		} else cropTo(form, localDay(dayAt(to, 1 - Number(d.crop))), to)
		return
	}
	// A person's log: which entries, which computer, and older ones.
	if ('show' in d) {
		open.show = d.show
		route()
	}
	if ('computer' in d) {
		open.computer = d.computer === open.computer ? '' : d.computer
		await route()
		$('log-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
	}
	if (btn.id === 'more') {
		try {
			const body = await api(personPath(d.before))
			$('log').insertAdjacentHTML('beforeend', body.log.map(entry).join(''))
			d.before = body.more ?? ''
			btn.hidden = !body.more
		} catch (err) {
			alert(err.message)
		}
	}
})

// cropTo shows the open project over the days from and to, either of which
// may be empty, in place: the page keeps its scroll, and Back skips it.
let keepScroll = false
function cropTo(form, from, to) {
	const q = new URLSearchParams()
	if (from) q.set('from', from)
	if (to) q.set('to', to)
	keepScroll = true
	location.replace(form.dataset.here + (q.size ? '?' + q : ''))
}
view.addEventListener('pointerdown', (e) => {
	const line = e.target.closest('.sub-line')
	const form = document.querySelector('[data-form="crop"]')
	if (!line || !form || e.button) return
	const box = line.getBoundingClientRect()
	const at = (x) => Math.min(1, Math.max(0, (x - box.left) / box.width))
	const start = at(e.clientX)
	const sel = document.createElement('span')
	sel.className = 'sub-sel'
	line.append(sel)
	line.setPointerCapture(e.pointerId)
	const show = (x) => {
		const a = Math.min(start, at(x)), b = Math.max(start, at(x))
		sel.style.left = `${a * 100}%`
		sel.style.width = `${(b - a) * 100}%`
		return [a, b]
	}
	show(e.clientX)
	const move = (m) => show(m.clientX)
	line.addEventListener('pointermove', move)
	line.addEventListener('pointerup', (u) => {
		line.removeEventListener('pointermove', move)
		const [a, b] = show(u.clientX)
		sel.remove()
		// A click, not a drag, crops nothing.
		if ((b - a) * box.width < 4) return
		const t0 = Number(line.dataset.t0), t1 = Number(line.dataset.t1)
		cropTo(form, localMinute(t0 + a * (t1 - t0)), localMinute(t0 + b * (t1 - t0)))
	}, { once: true })
})
view.addEventListener('change', (e) => {
	const form = e.target.closest('[data-form="crop"]')
	if (form) cropTo(form, form.elements.from.value, form.elements.to.value)
	// On a phone, the series the chart's one lower pane shows.
	if ('pane' in e.target.dataset) {
		lone = e.target.value
		redraw()
	}
	// People's table: only those who have synced, and its order.
	const narrowing = e.target.dataset.people
	if (narrowing) {
		listing[narrowing] = e.target.type === 'checkbox' ? e.target.checked : e.target.value
		drawPeople()
	}
})

// A search box: typing lists people, the arrow keys move through them, and Escape puts the list away.
view.addEventListener('input', (e) => {
	const form = e.target.closest?.('[data-form="find"]')
	if (form) find(form)
})
view.addEventListener('keydown', (e) => {
	const form = e.target.closest?.('[data-form="find"]')
	const box = form?.querySelector('.rv-found')
	if (!box) return
	const options = [...box.querySelectorAll('a')]
	if (e.key === 'Escape') {
		e.target.value = ''
		box.hidden = true
		find(form)
	}
	if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !options.length) return
	e.preventDefault()
	const at = options.findIndex((a) => a.getAttribute('aria-selected') === 'true')
	const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
	options.forEach((a, i) => a.setAttribute('aria-selected', String(i === next)))
})

// The side menu: its search button, the button that folds it, and on a phone the one that opens it.
document.addEventListener('click', (e) => {
	if (e.target.closest('[data-search]')) return toFind()
	if (e.target.closest('.rv-side a')) delete root.dataset.menu
	if (!e.target.closest('[data-side-toggle]')) return
	if (matchMedia('(max-width: 760px)').matches) {
		if ('menu' in root.dataset) delete root.dataset.menu
		else root.dataset.menu = 'open'
		return
	}
	const closed = root.dataset.side !== 'closed'
	if (closed) root.dataset.side = 'closed'
	else delete root.dataset.side
	try {
		localStorage.setItem(SIDE, closed ? 'closed' : 'open')
	} catch {}
})
document.addEventListener('keydown', (e) => {
	if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'k') return
	e.preventDefault()
	toFind()
})

// Copy buttons copy the text next to them.
document.addEventListener('click', async (e) => {
	const btn = e.target.closest?.('.copy')
	if (!btn) return
	try {
		await navigator.clipboard.writeText(btn.parentElement.querySelector('code').textContent)
		btn.textContent = 'Copied'
	} catch {
		btn.textContent = 'Select and copy'
	}
	setTimeout(() => (btn.textContent = 'Copy'), 1500)
})

async function start() {
	try {
		me = await api('/me')
	} catch (e) {
		view.innerHTML = notice('Could not open the review app', e.message)
		return
	}
	$('me').innerHTML = `<span>${esc(me.name || me.slack_id)}</span>${badge(me.level)}`
	for (const el of document.querySelectorAll('.rv-nav [data-min]')) el.hidden = me.level > Number(el.dataset.min)
	for (const el of document.querySelectorAll('[data-keys]')) el.textContent = KEYS
	// A new address is a new page, so it opens at its top.
	addEventListener('hashchange', () => route().then(() => (keepScroll ? (keepScroll = false) : scrollTo(0, 0))))
	route()
}
start()
