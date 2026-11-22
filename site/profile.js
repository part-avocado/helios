// A public profile, /@handle: anyone's hours, days, and public projects,
// from /api/public/v1/users/{handle}, which needs no sign-in.
const handle = decodeURIComponent(location.pathname.replace(/^\/@/, '').replace(/\/+$/, ''))

function notice(title, text) {
	$('notice').hidden = false
	$('content').hidden = true
	$('notice-title').textContent = title
	$('notice-text').textContent = text
}

function render(p) {
	document.title = `@${p.handle} - teardrop`
	$('title').textContent = `@${p.handle}`
	const joined = new Date(Number(p.joined.slice(0, 4)), Number(p.joined.slice(5, 7)) - 1)
	$('status').textContent = `Joined ${joined.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`

	// Days arrive as YYYY-MM-DD; the charts key them like dayKey.
	const perDay = new Map(p.days.map((d) => [d.date.split('-').map(Number).join('-'), d.engaged_seconds]))
	const now = new Date()
	let week = 0
	for (let i = 0; i < 7; i++) week += perDay.get(dayKey(addDays(now, -i))) || 0
	let streak = 0
	let d = startOfDay(now)
	if (!perDay.get(dayKey(d))) d = addDays(d, -1)
	while (perDay.get(dayKey(d))) streak++, (d = addDays(d, -1))
	const yearAgo = addDays(now, -364)
	const active = p.days.filter((x) => x.engaged_seconds > 0 && new Date(x.date + 'T00:00') >= startOfDay(yearAgo)).length

	$('s-total').textContent = dur(p.engaged_seconds)
	$('s-week').textContent = dur(week)
	$('s-week-hint').textContent = 'the last 7 days'
	$('s-streak').textContent = `${streak} ${streak === 1 ? 'day' : 'days'}`
	$('s-days').textContent = String(active)
	$('heatmap').innerHTML = heatmapHTML(perDay, now)

	const rows = p.projects.map((x) => `<tr><td>${x.repo ? `<a href="https://${esc(x.repo)}" rel="nofollow noopener">${esc(x.name)}</a>` : esc(x.name)}</td><td>${dur(x.engaged_seconds)}</td></tr>`)
	if (p.other_projects.count) {
		const n = p.other_projects.count
		rows.push(`<tr><td class="muted">${n} other ${n === 1 ? 'project' : 'projects'}</td><td>${dur(p.other_projects.engaged_seconds)}</td></tr>`)
	}
	$('projects').innerHTML = '<tr><th>Project</th><th>Engaged</th></tr>' + (rows.join('') || '<tr><td colspan="2" class="muted">No projects yet.</td></tr>')
	$('notice').hidden = true
	$('content').hidden = false
	// Start on the latest weeks, which is what the eye wants on a narrow screen. Only a shown element scrolls.
	$('heatmap').scrollLeft = $('heatmap').scrollWidth
}

async function load() {
	let res
	try {
		res = await fetch(`/api/public/v1/users/${encodeURIComponent(handle)}`)
	} catch {
		return notice('Could not load this profile', 'Check your connection and reload the page.')
	}
	if (res.status === 404) return notice('No such profile', 'There is no public profile at this address. Its owner may have changed their handle or made it private.')
	if (!res.ok) return notice('Could not load this profile', (await res.text()).trim())
	render(await res.json())
}

initTips($('content'))
if (handle) {
	load()
	// Whether they are at it now: the tool only, never the project.
	const live = `/api/public/v1/users/${encodeURIComponent(handle)}/live`
	liveFeed(live, live, (s) => {
		const text = liveText(s, false)
		$('live-now').hidden = !text
		$('live-now').innerHTML = text
	})
}
else notice('No such profile', 'A profile address looks like /@handle.')
