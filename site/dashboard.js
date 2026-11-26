// The dashboard shows teardrop reports. On the hosted site they are the
// signed-in visitor's synced reports (/api/report). From `teardrop dashboard`
// it is one signed report made live on this computer.
const DAY = 86400000
const hosted = 'hosted' in document.documentElement.dataset
const params = new URLSearchParams(location.search)
// Set when a neoadmin or superadmin opens someone else's stats from the review app.
const viewing = hosted ? params.get('user') : null
let report = null
// The range, and the project picked, come from the address (?days=7&project=…),
// and are kept in it, so a view can be linked, reloaded, and bookmarked.
let days = rangeFrom(params)
let live = false

// What the visitor has picked. Clicking a day on the heatmap or a bar picks
// that day (a week, on the yearly chart) and shows its work blocks below.
// Clicking a project picks it, and then every number and chart follows it.
// Clicking either again clears it.
let heatScrolled = false
let pick = null // { from: Date, to: Date, label: string }
let only = params.get('project') || null // a project key

const fmtDay = new Intl.DateTimeFormat(LANG, { weekday: 'short', month: 'short', day: 'numeric' })
const fmtShort = new Intl.DateTimeFormat(LANG, { month: 'short', day: 'numeric' })
const hm = new Intl.DateTimeFormat(LANG, { hour: '2-digit', minute: '2-digit' })
const hourName = (h) => new Date(2000, 0, 1, h % 24).toLocaleTimeString(LANG, { hour: 'numeric' })
const pct = (v, of) => (of ? Math.round((v / of) * 100) : 0) + '%'

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
	// How many prompts earned no time, in all.
	let noise = 0
	for (const p of report.projects || []) {
		if (only && p.project?.key !== only) continue
		noise += (p.noise_prompts || 0) + (p.repeat_prompts || 0) + (p.autopilot_prompts || 0)
	}

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
	$('s-total-hint').textContent = t('dash.activeSummary', { days: tn('common.activeDay', activeDays), avg: dur(activeDays ? total / activeDays : 0) })
	$('s-today').textContent = dur(today)
	$('s-today-hint').textContent = today ? t('dash.keepGoing') : t('dash.nothingToday')
	$('s-streak').textContent = tn('common.day', streak)
	$('s-top').textContent = top?.name || '-'
	$('s-top').title = top?.name || '' // in full, where the card cuts a long name short
	$('s-top-hint').textContent = top ? dur(top.engaged) : ''
	$('s-prompts').textContent = count(prompts)
	$('s-prompts-hint').textContent = noise ? t('dash.skipped', { n: noise }) : t('dash.noneSkipped')
	$('s-tokens').textContent = count(tin + tout)
	$('s-tokens-hint').textContent = t('dash.tokenHint', { read: count(tin), written: count(tout) })

	renderChips(projects, scoped)
	renderHeatmap(now, scoped)
	renderBars(perDay, from)

	const maxHour = Math.max(...perHour)
	$('hours-peak').textContent = maxHour > 0 ? t('dash.busiest', { hour: hourName(perHour.indexOf(maxHour)) }) : ''
	$('hours').innerHTML = perHour.map((v, h) =>
		`<div class="col"${tipAttrs(t('dash.hourRange', { from: hourName(h), to: hourName(h + 1) }), v ? t('dash.hourTip', { time: dur(v), pct: pct(v, perHour.reduce((a, b) => a + b, 0)) }) : t('common.noActivity'))}><i style="height:${maxHour ? (v / maxHour) * 100 : 0}%"></i></div>`).join('')

	const toolTotal = [...tools.values()].reduce((a, b) => a + b, 0)
	const maxTool = Math.max(1, ...tools.values())
	$('tools').innerHTML = [...tools].sort((a, b) => b[1] - a[1]).map(([tool, v]) => {
		const name = tool === 'unknown' ? t('dash.unknownTool') : tool
		return `<div class="row"${tipAttrs(name, t('dash.toolTip', { time: dur(v), pct: pct(v, toolTotal) }))}><div class="top"><span>${esc(name)}</span><span class="muted">${dur(v)}</span></div><div class="track"><div class="fill" style="width:${(v / maxTool) * 100}%"></div></div></div>`
	}).join('') ||
		`<p class="muted">${t('common.noActivityRange')}</p>`

	$('projects').innerHTML = `<tr><th>${t('common.project')}</th><th>${t('common.engaged')}</th><th>${t('dash.col.prompts')}</th><th>${t('dash.col.tokens')}</th></tr>` +
		(ranked.map((p) => `<tr class="pick${only === p.key ? ' sel' : ''}" data-project="${esc(p.key)}"><td><button type="button" class="link" aria-pressed="${only === p.key}" title="${t(only === p.key ? 'dash.showAllProjects' : 'dash.showOnlyProject')}">${esc(p.name)}</button></td><td>${dur(p.engaged)}</td><td>${p.prompts}</td><td>${count(p.tin)}/${count(p.tout)}</td></tr>`).join('') ||
			`<tr><td colspan="4" class="muted">${t('common.noActivityRange')}</td></tr>`)

	// With a day picked, list that day's blocks, even if it is outside the range above.
	const listed = (pick ? scoped.filter((b) => b.s >= pick.from && b.s < pick.to) : blocks).slice().sort((a, b) => b.s - a.s)
	$('blocks-title').textContent = pick ? t('dash.panel.blocksFor', { label: pick.label }) : t('dash.panel.recentBlocks')
	$('blocks').innerHTML = `<tr><th>${t('dash.col.when')}</th><th>${t('common.project')}</th><th>${t('common.engaged')}</th><th>${t('dash.col.span')}</th><th>${t('dash.col.prompts')}</th><th>${t('dash.col.tokens')}</th><th>${t('dash.col.tools')}</th></tr>` +
		(listed.slice(0, pick ? 100 : 25).map((b) =>
			`<tr><td>${fmtDay.format(b.s)}, ${hm.format(b.s)}–${hm.format(b.e)}</td><td>${esc(b.project.name)}</td><td>${dur(b.engaged_seconds)}</td><td>${dur((b.e - b.s) / 1000)}</td><td>${b.prompts}</td><td>${count(b.tokens_in)}/${count(b.tokens_out)}</td><td>${b.tools.map((tool) => `<span class="tag">${esc(tool)}</span>`).join('')}</td></tr>`).join('') ||
			`<tr><td colspan="7" class="muted">${pick ? t('dash.noBlocks') : t('common.noActivityRange')}</td></tr>`)
	labelCells()
	// A year with nothing in it says so, and what to do, instead of leaving a page of zeros to explain itself.
	$('no-data').hidden = all.length > 0
	if (!all.length) {
		$('no-data').innerHTML = hosted ? t('dash.noDataHosted') : t('dash.noDataLocal')
	}
	syncURL(only && (projects.get(only)?.name || scoped[0]?.project.name || only))
	showProjectSettings()
}

// syncURL puts the project picked and the range in the address, leaving the
// rest of it (such as a reviewer's ?user=) as it is, and names the project
// in the tab's title.
function syncURL(name) {
	const url = new URL(location.href)
	if (only) url.searchParams.set('project', only)
	else url.searchParams.delete('project')
	if (days !== 30) url.searchParams.set('days', String(days))
	else url.searchParams.delete('days')
	if (url.href !== location.href) history.replaceState(history.state, '', url)
	document.title = name ? t('dash.projectTitle', { name }) : t('dash.title')
}

// projectsURL is the projects page, for the same person and range.
function projectsURL() {
	const q = new URLSearchParams()
	if (viewing) q.set('user', viewing)
	if (days !== 30) q.set('days', String(days))
	return 'projects.html' + (q.size ? '?' + q : '')
}

// renderChips shows what is picked, each with a way to clear it.
function renderChips(projects, scoped) {
	const chips = []
	if (only) {
		chips.push(`<button type="button" class="chip" data-clear="project" title="${t('dash.showAllProjects')}">${esc(projects.get(only)?.name || scoped[0]?.project.name || only)}${X}</button>`)
		chips.push(`<a class="link" href="${esc(projectsURL())}">${t('dash.allProjects')}</a>`)
	}
	if (pick) {
		const inPick = scoped.filter((b) => b.s >= pick.from && b.s < pick.to)
		const secs = inPick.reduce((n, b) => n + b.engaged_seconds, 0)
		chips.push(`<button type="button" class="chip" data-clear="pick" title="${t('dash.backToRange')}">${esc(pick.label)} · ${dur(secs)}${X}</button>`)
		chips.push(`<a class="link" href="#blocks-panel">${t('dash.seeBlocks')}</a>`)
	}
	$('chips').hidden = !chips.length
	$('chips').innerHTML = chips.length ? `<span class="muted">${t('dash.showing')}</span>` + chips.join('') : ''
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
	$('heatmap').innerHTML = heatmapHTML(perDay, now, { clickable: true, selected: (d) => picked(d, 1) })
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
	$('bars-title').textContent = step === 7 ? t('dash.panel.perWeek') : t('dash.panel.perDay')
	$('bars-peak').textContent = max > 0 ? t('dash.peak', { time: dur(max) }) : ''
	$('bars').classList.toggle('dense', vals.length > 40)
	$('bars').innerHTML = vals.map(([d, v]) => {
		const label = step === 7 ? t('dash.weekOf', { date: fmtShort.format(d) }) : fmtDate.format(d)
		const click = v > 0 ? ` data-ts="${d.getTime()}" data-span="${step}" data-label="${esc(label)}"` : ''
		return `<button type="button" class="col${picked(d, step) ? ' sel' : ''}"${click}${v > 0 ? '' : ' tabindex="-1"'}${tipAttrs(label, v ? dur(v) : t('common.noActivity'), v ? t(step === 7 ? 'dash.clickWeek' : 'dash.clickDay') : '')}><i style="height:${max ? Math.max((v / max) * 100, v ? 1.5 : 0) : 0}%"></i></button>`
	}).join('')
	$('bar-labels').innerHTML = `<span>${fmtShort.format(first)}</span><span>${fmtShort.format(addDays(from, days - 1))}</span>`
}

// verify, verifiedNote, and merge, which read reports, are in reports.js.

// The page shows one of four things: stats, the setup steps, a notice, or,
// until the first answer arrives, the shapes of the stats to come.
function reveal(id) {
	for (const part of ['content', 'setup', 'notice', 'loading']) $(part).hidden = part !== id
	$('range').hidden = id !== 'content'
}

function show(rep, source) {
	report = rep
	reveal('content')
	$('status').innerHTML = source
	render()
}

// notice says why there are no stats to show. With retry it offers to ask
// again now, for a failure that may have passed.
function notice(title, html, retry = false) {
	reveal('notice')
	$('status').textContent = ''
	$('notice-title').textContent = title
	$('notice-text').innerHTML = html
	$('notice-actions').hidden = !retry
}
$('notice-retry').addEventListener('click', () => {
	reveal('loading')
	loadHosted()
})

let setupReady = false
let noteAsked = false // whether profileNote has been asked for, once there are stats

// showSetup nudges a signed-in visitor with nothing synced to connect a computer.
async function showSetup() {
	if (!setupReady) {
		renderSetup($('setup-steps'))
		setupReady = true
	}
	reveal('setup')
	$('status').textContent = ''
}

let hostedTimer = 0
const again = (ms) => {
	clearTimeout(hostedTimer)
	hostedTimer = setTimeout(loadHosted, ms)
}

async function loadHosted() {
	let body
	try {
		body = await api('/api/report' + (viewing ? `?user=${encodeURIComponent(viewing)}` : ''))
		if (viewing) {
			$('title').textContent = body.person.name ? t('dash.statsFor', { name: body.person.name }) : t('dash.theirStats')
			document.querySelector('.nav .links .active')?.classList.remove('active')
		}
		if (!viewing) showBan(body.ban)
		if (!body.computers.length) {
			if (viewing) notice(t('dash.notice.nothingSynced'), t('dash.notice.noComputers'))
			else if (body.ban) notice(t('dash.notice.nothingSyncedBanned'), t('dash.notice.bannedBefore'))
			else await showSetup()
			again(10000) // so the stats appear as soon as the first sync lands
			return
		}
	} catch (e) {
		if (report) $('status').textContent = t('dash.status.unreachable')
		else notice(viewing ? t('dash.notice.cannotLoadThese') : t('dash.notice.cannotLoadYour'), esc(e.message), true)
		again(15000)
		return
	}
	if (!viewing && !noteAsked) {
		noteAsked = true
		profileNote().catch(() => {})
	}
	const last = Math.max(...body.computers.map((c) => c.synced_at))
	const stale = Date.now() - last > 3 * DAY
	const from = tn('common.computer', body.computers.length)
	show(merge(body.computers, body.days), `<span class="dot${stale ? ' old' : ''}"></span>${t('dash.status.synced', { ago: esc(ago(last)), from })}` +
		(viewing ? ` · <a href="/review/#/person/id:${encodeURIComponent(viewing)}">${t('dash.status.review')}</a> · <a href="/review/#/people">${t('dash.status.allPeople')}</a>` : body.ban ? ` · <b>${t('dash.status.paused')}</b>` : stale ? ` · ${t('dash.status.runSync')}` : ''))
	again(5 * 60000)
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
			notice(t('dash.notice.liveOnComputer'), t('dash.notice.liveHowTo'))
			return
		}
		// teardrop dashboard was stopped or the computer slept: keep the last stats and keep asking.
		$('status').textContent = t('dash.status.lostContact')
		setTimeout(poll, 5000)
		return
	}
	try {
		const p = await verify(body)
		live = true
		show(p.report, `<span class="dot live"></span>${t('dash.status.live', { time: new Date().toLocaleTimeString(LANG), note: verifiedNote(p) })}`)
	} catch (e) {
		// Stats already on the page stay, with what went wrong beside the title.
		if (report) $('status').textContent = e.message
		else notice(t('dash.notice.cannotShow'), esc(e.message))
	}
	setTimeout(poll, 30000)
}

for (const b of document.querySelectorAll('#range button')) {
	b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days))
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

initTips($('content'))

// A project's page shows its owner that project's settings: whether their
// public profile shows it, and the GitHub repositories linked to it.
let owned = null // the visitor's projects from /api/projects, once asked for
let profile = null // their handle and whether their profile is public
async function showProjectSettings() {
	const panel = $('project-settings')
	if (!hosted || viewing || !only) return void (panel.hidden = true)
	if (!owned) {
		owned = []
		try {
			const [mine, me] = await Promise.all([api('/api/projects'), api('/api/me')])
			owned = mine.projects
			profile = { handle: me.handle, public: me.profile_public }
		} catch {
			owned = null
			return void (panel.hidden = true)
		}
	}
	const p = owned.find((x) => x.key === only)
	panel.hidden = !p
	if (!p) return
	$('ps-public').checked = p.shown
	const url = `${location.origin}/@${profile.handle}`
	const link = `<a href="${esc(url)}">${esc(url.replace(/^https?:\/\//, ''))}</a>`
	$('ps-public-hint').innerHTML = !p.shown ? t('project.public.off') : profile.public ? t('project.public.on', { link }) : t('project.public.profilePrivate', { link })
	$('ps-repos').innerHTML = p.repos.map((r) => `<div class="item">
			<div class="grow"><a href="https://${esc(r)}" rel="nofollow noopener">${esc(r)}</a></div>
			<button class="btn small danger" type="button" data-remove="${esc(r)}">${t('project.repos.remove')}</button>
		</div>`).join('') || `<div class="item"><div class="grow muted">${t('project.repos.none')}</div></div>`
}

function psSay(text, ok) {
	$('ps-msg').textContent = text
	$('ps-msg').className = 'msg ' + (ok ? 'ok' : 'bad')
	$('ps-msg').hidden = false
}

// saveProject sends changes to the project on this page, then shows what is saved.
async function saveProject(changes, done) {
	const key = only
	try {
		owned = (await api('/api/projects', { method: 'POST', body: JSON.stringify({ key, ...changes }) })).projects
		if (done) psSay(done, true)
		else $('ps-msg').hidden = true
		return true
	} catch (e) {
		psSay(e.message, false)
		return false
	} finally {
		showProjectSettings()
	}
}

$('ps-public').addEventListener('change', (e) => saveProject({ public: e.target.checked }, e.target.checked ? t('project.public.nowOn') : t('project.public.nowOff')))
$('ps-add').addEventListener('submit', async (e) => {
	e.preventDefault()
	const p = owned?.find((x) => x.key === only)
	if (!p) return
	const button = e.target.querySelector('button')
	button.disabled = true
	if (await saveProject({ repos: [...p.repos, $('ps-repo').value] }, t('project.repos.added'))) $('ps-repo').value = ''
	button.disabled = false
})
$('ps-repos').addEventListener('click', (e) => {
	const r = e.target.closest('[data-remove]')?.dataset.remove
	const p = owned?.find((x) => x.key === only)
	if (r && p) saveProject({ repos: p.repos.filter((x) => x !== r) }, t('project.repos.removed', { repo: r }))
})

// Profiles are public by default, so each person is told once, with the
// address of theirs and where to change it: once there is something on it,
// so a new account's first sight is its setup. Not when a reviewer is viewing.
async function profileNote() {
	if (localStorage.getItem('teardrop-profile-note')) return
	const me = await api('/api/me')
	if (!me.profile_public || !me.handle) return
	const url = `${location.origin}/@${me.handle}`
	$('profile-note-link').href = url
	$('profile-note-link').textContent = url.replace(/^https?:\/\//, '')
	$('profile-note').hidden = false
}
$('profile-note-ok').addEventListener('click', () => {
	localStorage.setItem('teardrop-profile-note', '1')
	$('profile-note').hidden = true
})

// Live: each prompt and turn end shows within seconds. When a turn ends, its
// sync follows shortly, so the stats are read again then.
let wasWorking = false
function onLive(s) {
	const text = liveText(s, true)
	$('live-now').hidden = !text
	$('live-now').innerHTML = text
	if (wasWorking && s.working?.kind === 'agent') again(20000)
	wasWorking = !!s.working
}

if (hosted) {
	loadHosted()
	if (!viewing) liveFeed('/api/live', '/api/live/ws', onLive)
} else poll()
