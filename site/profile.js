// A public profile, /@handle: anyone's hours, days, and public projects,
// from /api/public/v1/users/{handle}, which needs no sign-in.
const handle = decodeURIComponent(location.pathname.replace(/^\/@/, '').replace(/\/+$/, ''))

// notice says why there is no profile to show. With retry it offers to ask
// again, for a failure that may have passed.
function notice(title, text, retry = false) {
	$('notice').hidden = false
	$('content').hidden = $('loading').hidden = true
	$('notice-title').textContent = title
	$('notice-text').textContent = text
	$('notice-actions').hidden = !retry
}
$('notice-retry').addEventListener('click', () => {
	$('notice').hidden = true
	$('loading').hidden = false
	load()
})

function render(p) {
	document.title = `@${p.handle} - teardrop`
	$('title').textContent = `@${p.handle}`
	const joined = new Date(Number(p.joined.slice(0, 4)), Number(p.joined.slice(5, 7)) - 1)
	$('status').textContent = t('profile.joined', { date: joined.toLocaleDateString(LANG, { month: 'long', year: 'numeric' }) })

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
	$('s-week-hint').textContent = t('profile.last7')
	$('s-streak').textContent = tn('common.day', streak)
	$('s-days').textContent = String(active)
	$('heatmap').innerHTML = heatmapHTML(perDay, now)

	// A public repository's latest commits link to the host, marked when GitHub has them.
	const commits = (x) => !x.commits?.length ? '' : `<div class="fine muted">${x.commits.map((c) => `<a href="https://${esc(x.repo)}/commit/${esc(c.sha)}" rel="nofollow noopener"><code>${esc(c.sha.slice(0, 7))}</code></a>${c.found === true ? ' ✓' : c.found === false ? t('profile.notOnGithub') : ''}`).join(', ')}${x.checked ? '' : t('profile.notChecked')}</div>`
	const rows = p.projects.map((x) => `<tr><td>${x.repo ? `<a href="https://${esc(x.repo)}" rel="nofollow noopener">${esc(x.name)}</a>` : esc(x.name)}${commits(x)}</td><td>${dur(x.engaged_seconds)}</td></tr>`)
	if (p.other_projects.count) {
		const n = p.other_projects.count
		rows.push(`<tr><td class="muted">${tn('common.otherProject', n)}</td><td>${dur(p.other_projects.engaged_seconds)}</td></tr>`)
	}
	$('projects').innerHTML = `<tr><th>${t('common.project')}</th><th>${t('common.engaged')}</th></tr>` + (rows.join('') || `<tr><td colspan="2" class="muted">${t('profile.noProjects')}</td></tr>`)
	labelCells()
	$('notice').hidden = $('loading').hidden = true
	$('content').hidden = false
	// Start on the latest weeks, which is what the eye wants on a narrow screen. Only a shown element scrolls.
	$('heatmap').scrollLeft = $('heatmap').scrollWidth
}

async function load() {
	let res
	try {
		res = await fetch(`/api/public/v1/users/${encodeURIComponent(handle)}`)
	} catch {
		return notice(t('profile.err.loadTitle'), t('profile.err.loadText'), true)
	}
	if (res.status === 404) return notice(t('profile.err.noneTitle'), t('profile.err.noneText'))
	if (!res.ok) return notice(t('profile.err.loadTitle'), (await res.text()).trim(), true)
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
else notice(t('profile.err.noneTitle'), t('profile.err.addressText'))
