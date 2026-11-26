// The projects page: every project in a person's reports, as a card, with the
// time spent on it in the range picked. A card opens the dashboard for just
// that project. On the hosted site the reports are the signed-in visitor's
// synced ones (/api/report); from `helios dashboard` it is the signed
// report made live on this computer. reports.js reads both.
const hosted = 'hosted' in document.documentElement.dataset
const params = new URLSearchParams(location.search)
// Set when a reviewer opens someone else's projects, as on the dashboard.
const viewing = hosted ? params.get('user') : null
let report = null
let days = rangeFrom(params)
let query = params.get('q') || ''
// The GitHub repositories the visitor linked to each of their projects, by key, once loaded.
let linked = new Map()

// A project named by its repository, such as github.com/owner/name, links to it.
const REPO = /^(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/[\w.-]+\/[\w.-]+$/
const repoOf = (key) => (REPO.test(key) ? key : '')

const LINK = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

// The page shows one of four things: the projects, that there are none yet, a
// notice, or, until the first answer arrives, the shapes of the cards to come.
function reveal(id) {
	for (const part of ['content', 'empty', 'notice', 'loading']) $(part).hidden = part !== id
	$('range').hidden = id !== 'content'
}

function notice(title, html, retry = false) {
	reveal('notice')
	$('status').textContent = ''
	$('notice-title').textContent = title
	$('notice-text').innerHTML = html
	$('notice-actions').hidden = !retry
}

// projects adds up each project's blocks in the range, and when it was last worked on at all.
function projects() {
	const from = addDays(new Date(), -(days - 1))
	const all = new Map()
	for (const b of report.blocks || []) {
		const key = b.project.key
		const p = all.get(key) || { key, name: b.project.name, engaged: 0, prompts: 0, tools: new Map(), last: 0 }
		const end = Date.parse(b.end)
		p.last = Math.max(p.last, end)
		if (end >= from.getTime()) {
			p.engaged += b.engaged_seconds
			p.prompts += b.prompts
			for (const tool of b.tools?.length ? b.tools : ['unknown']) p.tools.set(tool, (p.tools.get(tool) || 0) + b.engaged_seconds / Math.max(1, b.tools?.length || 1))
		}
		all.set(key, p)
	}
	return [...all.values()]
}

// dashURL is the dashboard for one project, for the same person and range.
function dashURL(key) {
	const q = new URLSearchParams()
	if (viewing) q.set('user', viewing)
	q.set('project', key)
	if (days !== 30) q.set('days', String(days))
	return 'dashboard.html?' + q
}

function card(p, total, max) {
	const repos = linked.get(p.key) ?? (repoOf(p.key) ? [repoOf(p.key)] : [])
	const repo = repos[0]
	const tools = [...p.tools].sort((a, b) => b[1] - a[1]).map(([tool]) => `<span class="tag">${esc(tool === 'unknown' ? t('dash.unknownTool') : tool)}</span>`).join('')
	const share = total ? Math.round((p.engaged / total) * 100) : 0
	return `<article class="project-card">
		<h2><a class="open" href="${esc(dashURL(p.key))}" title="${esc(t('projects.open', { name: p.name }))}">${esc(p.name)}</a></h2>
		<p class="key">${repo ? `<a class="repo" href="https://${esc(repo)}" rel="nofollow noopener" title="${esc(t('projects.repo', { repo }))}"><span>${esc(repo)}</span>${LINK}</a>${repos.length > 1 ? ` <span class="muted">+${repos.length - 1}</span>` : ''}` : `<span title="${esc(p.key)}">${esc(p.key)}</span>`}</p>
		<div class="time"><b>${dur(p.engaged)}</b><span class="muted">${t('projects.share', { pct: share + '%' })}</span></div>
		<div class="track" aria-hidden="true"><div class="fill" style="width:${max ? (p.engaged / max) * 100 : 0}%"></div></div>
		<dl class="facts-row">
			<div><dt>${t('dash.col.prompts')}</dt><dd>${count(p.prompts)}</dd></div>
			<div><dt>${t('projects.lastActive')}</dt><dd title="${esc(new Date(p.last).toLocaleString(LANG))}">${esc(ago(p.last))}</dd></div>
		</dl>
		<p class="tools">${tools}</p>
	</article>`
}

function render() {
	if (!report) return
	const list = projects()
	if (!list.length) return showEmpty()
	reveal('content')
	const inRange = list.filter((p) => p.engaged > 0).sort((a, b) => b.engaged - a.engaged || b.last - a.last)
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	const shown = inRange.filter((p) => words.every((w) => (p.name + ' ' + p.key).toLowerCase().includes(w)))
	const total = inRange.reduce((n, p) => n + p.engaged, 0)
	const max = Math.max(0, ...inRange.map((p) => p.engaged))
	$('cards').innerHTML = shown.map((p) => card(p, total, max)).join('')
	$('count').textContent = shown.length || !words.length ? tn('projects.count', shown.length) : ''
	$('none').hidden = shown.length > 0
	$('none').textContent = inRange.length ? t('projects.noMatch', { q: query.trim() }) : t('projects.noneInRange')
}

function showEmpty() {
	if (viewing) return notice(t('dash.notice.nothingSynced'), t('dash.notice.noComputers'))
	reveal('empty')
	$('empty-text').innerHTML = hosted ? t('projects.empty.hosted') : t('projects.empty.local')
}

// syncURL keeps the range and the search in the address, so the view can be linked and reloaded.
function syncURL() {
	const url = new URL(location.href)
	if (days !== 30) url.searchParams.set('days', String(days))
	else url.searchParams.delete('days')
	if (query.trim()) url.searchParams.set('q', query.trim())
	else url.searchParams.delete('q')
	if (url.href !== location.href) history.replaceState(history.state, '', url)
}

let timer = 0
const again = (fn, ms) => {
	clearTimeout(timer)
	timer = setTimeout(fn, ms)
}

async function loadHosted() {
	let body
	try {
		body = await api('/api/report' + (viewing ? `?user=${encodeURIComponent(viewing)}` : ''))
	} catch (e) {
		if (report) $('status').textContent = t('dash.status.unreachable')
		else notice(viewing ? t('dash.notice.cannotLoadThese') : t('dash.notice.cannotLoadYour'), esc(e.message), true)
		return again(loadHosted, 15000)
	}
	if (viewing) {
		$('title').textContent = body.person.name ? t('projects.for', { name: body.person.name }) : t('projects.theirs')
		document.querySelector('.nav .links .active')?.classList.remove('active')
	} else {
		showBan(body.ban)
		try {
			linked = new Map((await api('/api/projects')).projects.map((p) => [p.key, p.repos]))
		} catch {}
	}
	if (!body.computers.length) {
		report = null
		$('status').textContent = ''
		showEmpty()
		return again(loadHosted, 10000) // so the projects appear as soon as the first sync lands
	}
	const last = Math.max(...body.computers.map((c) => c.synced_at))
	const stale = Date.now() - last > 3 * 86400000
	report = merge(body.computers, body.days)
	$('status').innerHTML = `<span class="dot${stale ? ' old' : ''}"></span>${t('dash.status.synced', { ago: esc(ago(last)), from: tn('common.computer', body.computers.length) })}`
	render()
	again(loadHosted, 5 * 60000)
}

// loadLocal reads the live report that `helios dashboard` serves on this computer.
async function loadLocal() {
	let body
	try {
		const res = await fetch('/api/report?since=365d', { cache: 'no-store' })
		if (!res.ok) throw new Error(res.status)
		body = await res.json()
	} catch {
		if (!report) return notice(t('dash.notice.liveOnComputer'), t('dash.notice.liveHowTo'))
		$('status').textContent = t('dash.status.lostContact')
		return again(loadLocal, 5000)
	}
	try {
		const p = await verify(body)
		report = p.report
		$('status').innerHTML = `<span class="dot live"></span>${t('dash.status.live', { time: new Date().toLocaleTimeString(LANG), note: verifiedNote(p) })}`
		render()
	} catch (e) {
		if (report) $('status').textContent = e.message
		else notice(t('dash.notice.cannotShow'), esc(e.message))
	}
	again(loadLocal, 30000)
}

for (const b of document.querySelectorAll('#range button')) {
	b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days))
	b.addEventListener('click', () => {
		days = Number(b.dataset.days)
		for (const o of document.querySelectorAll('#range button')) o.setAttribute('aria-pressed', String(o === b))
		syncURL()
		render()
	})
}
$('search').value = query
$('search').addEventListener('input', () => {
	query = $('search').value
	syncURL()
	render()
})
$('search').addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && $('search').value) {
		$('search').value = query = ''
		syncURL()
		render()
	}
})
$('notice-retry').addEventListener('click', () => {
	reveal('loading')
	loadHosted()
})

if (hosted) loadHosted()
else loadLocal()
