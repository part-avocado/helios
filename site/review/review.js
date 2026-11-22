// The review app. What it shows depends on the visitor's level: a reviewer
// (2) looks a person up and reads their total for each project; a neoadmin
// (1) and a superadmin (0) read everything and manage reviewers and bans.
// The server decides what each may do. This page only leaves out what the
// server would refuse.
const $ = (id) => document.getElementById(id)
const view = $('view')
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
	'look a person up by Slack ID and read their total for each project',
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
const until = (ms) => (ms == null ? 'until lifted' : `until ${when(ms)}`)
const head = (title, extra = '') => `<div class="dash-head"><h1>${title}</h1>${extra}</div>`
const notice = (title, text) => `<div class="empty"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>`
const LOOKUP = `<form class="lookup" role="search" data-form="lookup">
	<input name="slack" aria-label="Slack ID" placeholder="Slack ID, such as U012ABCDEF" autocomplete="off" spellcheck="false" required>
	<button class="btn">Look up</button>
</form>`

function say(el, text, ok = false) {
	el.textContent = text
	el.className = 'msg ' + (ok ? 'ok' : 'bad')
	el.hidden = false
}

// ---- People

async function people() {
	if (me.level === 2) {
		return head('Look someone up') + `<div class="panel">
			<p>Enter the Slack ID of the person whose work you are checking. In Slack: open their profile, choose ⋮, then Copy member ID.</p>
			${LOOKUP.replace('class="lookup"', 'class="lookup start"')}
		</div>
		<p class="muted fine">As a reviewer you see a person's total for each project, and nothing else of theirs. A neoadmin can read their computers and every report they sent.</p>`
	}
	const { people } = await api('/people')
	const rows = people.map((p) => `<tr>
		<td><a href="#/person/id:${p.id}">${esc(p.name || (p.deleted_at ? 'Deleted account' : 'No name'))}</a></td>
		<td>${p.slack_id ? `<code>${esc(p.slack_id)}</code>` : '<span class="muted">none</span>'}</td>
		<td>${dur(p.engaged_seconds)}</td><td>${p.computers}</td>
		<td>${p.flagged ? `<a class="flag" href="#/person/id:${p.id}">${p.flagged}</a>` : '<span class="muted">0</span>'}</td>
		<td>${p.synced_at ? esc(ago(p.synced_at)) : '<span class="muted">never</span>'}</td>
	</tr>`).join('')
	return head('People', `<span class="status">${plural(people.length, 'person', 'people')}</span>${LOOKUP}`) + `<div class="panel">
		<div class="table-scroll"><table class="data people">
			<tr><th>Name</th><th>Slack ID</th><th>Engaged, past year</th><th>Computers</th><th>Flagged</th><th>Last sync</th></tr>
			${rows || '<tr><td colspan="6" class="muted">No one has signed in yet.</td></tr>'}
		</table></div>
	</div>
	<p class="muted fine">Choose a person to read their computers, their projects, and every report they sent.</p>`
}

// ---- One person

function projectTable(projects) {
	if (!projects.length) return '<p class="muted">No project has time yet.</p>'
	const total = projects.reduce((sum, p) => sum + p.engaged_seconds, 0)
	return `<div class="table-scroll"><table class="data left">
		<tr><th>Project</th><th>Share</th><th>Engaged, past year</th></tr>
		${projects.map((p) => `<tr><td>${esc(p.name)}</td><td>${Math.round((100 * p.engaged_seconds) / total)}%</td><td>${dur(p.engaged_seconds)}</td></tr>`).join('')}
	</table></div>`
}

const banForm = (slack = '') => `<form class="rv-form" data-form="ban">
	${slack ? `<input type="hidden" name="slack_id" value="${esc(slack)}">` : '<label>Slack ID<input name="slack_id" placeholder="U012ABCDEF" autocomplete="off" spellcheck="false" required></label>'}
	<label class="grow">Reason, which the person is shown<input name="reason" maxlength="500" autocomplete="off" required></label>
	<label>For<select name="days">
		<option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="">Until lifted</option>
	</select></label>
	<button class="btn danger">Ban</button>
</form>
<p class="msg" role="alert" hidden></p>`

const banRow = (b, withName) => `<div class="item">
	<div class="grow">${withName ? named(b.name, b.slack_id) + ' ' : ''}<span class="badge${b.active ? ' banned' : ''}">${b.active ? `Banned ${esc(until(b.until))}` : b.lifted_at ? 'Lifted' : 'Over'}</span>
		<div class="sub">${esc(b.reason)}</div>
		<div class="sub">By ${named(b.by_name, b.by_slack_id)}, ${esc(ago(b.at))}${b.lifted_at ? `. Ended early by ${named(b.lifted_by_name, b.lifted_by)}, ${esc(ago(b.lifted_at))}.` : b.active ? '' : `. It ran out ${esc(ago(b.until))}.`}</div>
	</div>
	${b.active ? `<button class="btn small" type="button" data-lift="${b.id}">Lift</button>` : ''}
</div>`

// What a reviewer sees of a person: who they are and each project's total.
function summaryView(b) {
	const p = b.person
	const name = p.name || (p.deleted_at ? 'Deleted account' : 'No name')
	return `<div class="review">
		<a class="back" href="#/"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>Look up someone else</a>
		${head(esc(name), `<span class="status"><code>${esc(p.slack_id)}</code></span>${b.ban ? '<span class="badge banned">Banned</span>' : ''}`)}
		${b.ban ? `<div class="panel attention"><h2>Banned ${esc(until(b.ban.until))}</h2><p>${esc(b.ban.reason)}</p></div>` : ''}
		<div class="stats">
			<div class="stat"><div class="label">Engaged, as synced</div><div class="value">${dur(b.engaged_seconds)}</div><div class="hint">in the past year</div></div>
			<div class="stat"><div class="label">Projects</div><div class="value">${b.projects.length}</div><div class="hint">with time in the past year</div></div>
			<div class="stat"><div class="label">Last sync</div><div class="value">${b.synced_at ? esc(ago(b.synced_at)) : 'never'}</div><div class="hint">joined ${esc(longDate(p.created_at))}</div></div>
			<div class="stat"><div class="label">Flagged reports</div><div class="value${b.flagged_reports ? ' bad' : ''}">${b.flagged_reports}</div><div class="hint">${b.flagged_reports ? 'ask a neoadmin to read them' : 'nothing stood out'}</div></div>
		</div>
		<div class="panel"><h2>Projects</h2>${projectTable(b.projects)}</div>
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
	const name = p.name || (p.deleted_at ? 'Deleted account' : 'No name')
	const engaged = computers.reduce((sum, c) => sum + c.engaged_seconds, 0)
	const banned = b.bans.some((x) => x.active)
	const facts = [
		['Name', esc(name)],
		['Slack ID', p.slack_id ? `<code>${esc(p.slack_id)}</code>` : 'None'],
		['Joined', esc(longDate(p.created_at))],
		['Account', `#${p.id}`],
		...(p.deleted_at ? [['Deleted', esc(longDate(p.deleted_at)) + '. Its log is kept.']] : []),
	]
	const none = open.show ? `No ${open.show} entries${open.computer ? ' for this computer' : ''}.` : open.computer ? 'No entries for this computer.' : 'Nothing yet. Entries appear from the first sync after this log was added.'
	return `<div class="review">
		<a class="back" href="#/"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>All people</a>
		${head(esc(name), `<span class="status">${p.slack_id ? `<code>${esc(p.slack_id)}</code>` : 'No Slack ID'}</span>${banned ? '<span class="badge banned">Banned</span>' : ''}${LOOKUP}`)}
		<div class="stats">
			<div class="stat"><div class="label">Engaged, as synced</div><div class="value">${dur(engaged)}</div><div class="hint">${computers.length === 1 ? 'from 1 computer' : `from ${computers.length} computers`}</div></div>
			<div class="stat"><div class="label">Not checkable</div><div class="value">${dur(b.unchecked_seconds)}</div><div class="hint">earlier history from first syncs</div></div>
			<div class="stat"><div class="label">Flagged reports</div><div class="value${counts.flagged ? ' bad' : ''}">${counts.flagged}</div><div class="hint">${counts.flagged ? 'read these first' : 'nothing stood out'}</div></div>
			<div class="stat"><div class="label">Refused reports</div><div class="value">${counts.refused}</div><div class="hint">of ${counts.entries} log entries</div></div>
		</div>
		${b.impossible_days.length ? `<div class="panel attention"><h2>Days that don't add up</h2><ul>${b.impossible_days.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
		<div class="panels">
			<div class="panel">
				<h2>Account</h2>
				<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
				${p.deleted_at ? '' : `<a class="btn small" href="/dashboard?user=${p.id}">Open their dashboard</a>`}
			</div>
			<div class="panel">
				<h2>Computers</h2>
				<div class="table-scroll"><table class="data">
					<tr><th>Computer</th><th>Engaged</th><th>Version</th><th>Last sync</th><th></th></tr>
					${computers.map((c) => `<tr${c.id === open.computer ? ' class="sel"' : ''}><td><code>${esc(c.id)}</code></td><td>${dur(c.engaged_seconds)}</td>
						<td>${esc(c.teardrop_version || 'unknown')}</td><td title="${esc(exact(c.synced_at))}">${esc(ago(c.synced_at))}</td>
						<td class="acts"><button type="button" class="link" data-computer="${esc(c.id)}">History</button><a href="/api/review/report?computer=${encodeURIComponent(c.id)}" target="_blank" rel="noopener" title="Its latest report in full, with every work block">Full report</a></td></tr>`).join('') ||
					`<tr><td colspan="5" class="muted">${p.deleted_at ? 'None. They deleted their account.' : 'None. They have signed in, but nothing has synced.'}</td></tr>`}
				</table></div>
			</div>
			<div class="panel" data-area>
				<h2>Bans</h2>
				${p.slack_id ? banForm(p.slack_id) : '<p class="muted">This account has no Slack ID, and bans go by Slack ID.</p>'}
				${b.bans.length ? `<div class="list">${b.bans.map((x) => banRow(x, false)).join('')}</div>` : ''}
			</div>
			<div class="panel"><h2>Projects</h2>${projectTable(b.projects)}</div>
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

async function person(arg) {
	if (!arg) return people()
	const who = arg.startsWith('id:') ? `id=${encodeURIComponent(arg.slice(3))}` : `slack=${encodeURIComponent(arg)}`
	if (open.who !== who) open = { who, show: '', computer: '' }
	let body
	try {
		body = await api(personPath())
	} catch (e) {
		return head('No one found', LOOKUP) + notice('No one found', e.message)
	}
	return body.limited ? summaryView(body) : fullView(body)
}

// ---- Reviewers

async function team() {
	const t = await api('/team')
	const row = (r) => `<div class="item">
		<div class="grow">${named(r.name, r.slack_id)}${r.banned ? ' <span class="badge banned">Banned</span>' : ''}
			<div class="sub">${r.name == null ? 'Has not signed in yet. ' : ''}Added by ${named(r.added_by_name, r.added_by)}, ${esc(ago(r.added_at))}${r.note ? `: ${esc(r.note)}` : ''}</div>
		</div>
		${me.level === 0 ? `<button class="btn small" type="button" data-set-level="${r.level === 1 ? 2 : 1}" data-slack="${esc(r.slack_id)}">${r.level === 1 ? 'Make reviewer' : 'Make neoadmin'}</button>` : ''}
		${r.level > me.level ? `<button class="btn small danger" type="button" data-remove="${esc(r.slack_id)}">Remove</button>` : ''}
	</div>`
	const list = (level, none) => t.reviewers.filter((r) => r.level === level).map(row).join('') || `<div class="item"><div class="grow muted">${none}</div></div>`
	const ACTIONS = { add: 'added', change: 'changed', remove: 'removed', ban: 'banned', unban: 'lifted the ban on' }
	return head('Reviewers') + `<div class="panel" data-area>
		<h2>Add someone</h2>
		<p class="muted">Paste their Slack ID. In Slack: open their profile, choose ⋮, then Copy member ID. They can review from their next page load, and they don't need to have signed in before.</p>
		<form class="rv-form" data-form="add">
			<label>Slack ID<input name="slack_id" placeholder="U012ABCDEF" autocomplete="off" spellcheck="false" required></label>
			<label>As<select name="level"><option value="2">Reviewer</option>${me.level === 0 ? '<option value="1">Neoadmin</option>' : ''}</select></label>
			<label class="grow">Note, for the others<input name="note" maxlength="200" autocomplete="off" placeholder="Optional"></label>
			<button class="btn primary">Add</button>
		</form>
		<p class="msg" role="alert" hidden></p>
	</div>
	<div class="panel" data-area>
		<h2>Superadmins ${badge(0)}</h2>
		<p class="muted">They can ${CAN[0]}. They are the Slack IDs in the Worker's <code>ADMINS</code> variable, which is changed in the Cloudflare dashboard and not here.</p>
		<div class="list">${t.superadmins.map((s) => `<div class="item"><div class="grow">${named(s.name, s.slack_id)}${s.name == null ? '<div class="sub">Has not signed in yet.</div>' : ''}</div></div>`).join('') || '<div class="item"><div class="grow muted">None. ADMINS is empty.</div></div>'}</div>
		<h2>Neoadmins ${badge(1)}</h2>
		<p class="muted">They can ${CAN[1]}. Only a superadmin can add or remove one.</p>
		<div class="list">${list(1, 'None yet.')}</div>
		<h2>Reviewers ${badge(2)}</h2>
		<p class="muted">They can ${CAN[2]}.</p>
		<div class="list">${list(2, 'None yet. Add one above.')}</div>
		<p class="msg" role="alert" hidden></p>
	</div>
	<div class="panel">
		<h2>Changes</h2>
		${t.log.length ? `<div class="table-scroll"><table class="data left">
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
	return head('Bans') + `<div class="panel" data-area>
		<h2>Ban someone</h2>
		<p class="muted">While banned, nothing new is taken from the person: no syncs, uploads, cloud events, or submissions. They can still sign in and see what they had, with the reason you give. A banned reviewer can't review. You can ban only people below your own level.</p>
		${banForm()}
	</div>
	<div class="panel" data-area>
		<h2>In force</h2>
		<div class="list">${now.map((b) => banRow(b, true)).join('') || '<div class="item"><div class="grow muted">No one is banned.</div></div>'}</div>
		<p class="msg" role="alert" hidden></p>
		${past.length ? `<h2>Over</h2><div class="list">${past.map((b) => banRow(b, true)).join('')}</div>` : ''}
	</div>`
}

// ---- API keys

async function keyList() {
	const { keys } = await api('/keys')
	const all = [['GET /api/review/person?slack=U012ABCDEF', me.level === 2 ? "A person's total for each project." : "Everything about a person: computers, projects, bans, and a page of their log. Also takes id, show, computer, and before."]]
	if (me.level < 2) all.push(
		['GET /api/review/people', 'Everyone with an account.'],
		['GET /api/review/log?slack=…', "A person's whole log."],
		['GET /api/review/report?entry=… or ?computer=…', 'One report in full, as it was signed.'],
		['GET /api/review/team', 'Who can review, and the changes to that.'],
		['POST /api/review/team', 'Add a reviewer: {"slack_id", "level", "note"}.'],
		['DELETE /api/review/team/U012ABCDEF', 'Remove a reviewer.'],
		['GET /api/review/bans', 'Every ban.'],
		['POST /api/review/bans', 'Ban someone: {"slack_id", "reason", "days"}. Leave days out for a ban until lifted.'],
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

const ROUTES = { people, person, team, bans: banList, keys: keyList }
let turn = 0

// route draws the page the address names, such as #/person/U012ABCDEF.
async function route() {
	const mine = ++turn
	const [name = '', ...rest] = location.hash.replace(/^#\/?/, '').split('/')
	const page = name in ROUTES ? name : 'people'
	for (const a of document.querySelectorAll('.rv-side a')) {
		if (a.dataset.page === (page === 'person' ? 'people' : page)) a.setAttribute('aria-current', 'page')
		else a.removeAttribute('aria-current')
	}
	let html
	try {
		html = await ROUTES[page](decodeURIComponent(rest.join('/')))
	} catch (e) {
		html = notice('Could not load this', e.message)
	}
	if (mine === turn) view.innerHTML = html
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
	if (kind === 'lookup') location.hash = '#/person/' + encodeURIComponent(fields.slack.trim().replace(/^<@|>$/g, '').toUpperCase())
	if (kind === 'add') act(form, () => send('POST', '/team', fields))
	if (kind === 'ban') act(form, () => send('POST', '/bans', fields))
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
	if ('setLevel' in d) act(btn, () => send('POST', '/team', { slack_id: d.slack, level: Number(d.setLevel) }))
	if ('lift' in d && confirm('Lift this ban now?')) act(btn, () => send('DELETE', '/bans/' + d.lift))
	if ('revoke' in d && confirm(`Revoke the key "${d.name}"? Whatever uses it stops working at once.`)) act(btn, () => send('DELETE', '/keys/' + d.revoke))
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
	for (const a of document.querySelectorAll('.rv-side [data-min]')) a.hidden = me.level > Number(a.dataset.min)
	if (me.level === 2) document.querySelector('.rv-side [data-page="people"]').textContent = 'Look up'
	addEventListener('hashchange', route)
	route()
}
start()
