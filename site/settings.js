// Settings for the signed-in visitor. One pane shows at a time, chosen by the
// address: settings.html#data.
const panes = [...document.querySelectorAll('.pane')]

function showPane() {
	const id = panes.some((p) => p.id === location.hash.slice(1)) ? location.hash.slice(1) : 'setup'
	for (const p of panes) p.hidden = p.id !== id
	for (const a of document.querySelectorAll('.side a')) {
		if (a.hash === '#' + id) a.setAttribute('aria-current', 'page')
		else a.removeAttribute('aria-current')
	}
}
addEventListener('hashchange', showPane)
showPane()

function say(el, text, ok) {
	el.textContent = text
	el.className = 'msg ' + (ok ? 'ok' : 'bad')
	el.hidden = false
}

// The API only takes changes from this site's own pages, which the browser
// vouches for with the Origin header it adds to these requests.
const change = (path, method, body) => api(path, { method, body })

function listComputers(computers) {
	$('computer-list').innerHTML = computers.map((c) => `<div class="item">
			<div class="grow">${c.cloud ? 'Amp cloud threads ' : ''}<code>${esc(c.id)}</code>
				<div class="sub">Synced ${esc(ago(c.synced_at))} - ${dur(c.engaged_seconds)} in the past year${c.teardrop_version ? ` - teardrop ${esc(c.teardrop_version)}` : ''}</div></div>
			<button class="btn small danger" type="button" data-remove="${esc(c.id)}">Remove</button>
		</div>`).join('') ||
		'<div class="item"><div class="grow muted">No computers yet. <a href="#setup">Set one up</a> and it appears here after its first sync.</div></div>'
}

async function load() {
	const me = await api('/api/me')
	renderSetup($('setup-steps'), me.api_key)
	listComputers(me.computers)
	$('me-name').textContent = me.name || 'Not set'
	$('me-slack').textContent = me.slack_id || 'No Slack account linked'
	$('me-since').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(me.created_at)
	$('me-role').textContent = (['Superadmin', 'Neoadmin', 'Reviewer'][me.level] ?? 'Member') + (me.ban ? `. Banned ${me.ban.until ? `until ${new Date(me.ban.until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'until a reviewer lifts the ban'}: ${me.ban.reason}` : '')
}

$('new-key').addEventListener('click', async () => {
	if (!confirm('Make a new sync key? Your computers stop syncing until you run the new connect command on each of them.')) return
	try {
		const key = (await change('/api/key', 'POST')).api_key
		renderSetup($('setup-steps'), key)
		// The new key in a popup, to copy to wherever the old one was.
		$('new-key-value').textContent = key
		$('new-key-connect').textContent = `teardrop sync -server ${location.origin} -key ${key}`
		$('key-dialog').showModal()
		say($('key-msg'), 'New key made. The steps above now use it.', true)
	} catch (e) {
		say($('key-msg'), e.message, false)
	}
})

$('computer-list').addEventListener('click', async (e) => {
	const id = e.target.closest('[data-remove]')?.dataset.remove
	if (!id || !confirm(`Remove ${id} and its hours from your account? It comes back if it syncs again.`)) return
	try {
		await change('/api/computers/' + encodeURIComponent(id), 'DELETE')
		listComputers((await api('/api/me')).computers)
		$('computer-msg').hidden = true
	} catch (e) {
		say($('computer-msg'), e.message, false)
	}
})

async function upload(file) {
	const msg = $('upload-msg')
	$('file').value = '' // so choosing the same file again still uploads it
	try {
		const { computer } = await change('/api/reports', 'POST', await file.text())
		msg.innerHTML = `Added the stats from computer <code>${esc(computer)}</code>. <a href="dashboard.html">See your dashboard</a>`
		msg.className = 'msg ok'
		msg.hidden = false
		listComputers((await api('/api/me')).computers)
	} catch (e) {
		say(msg, e.message, false)
	}
}
$('file').addEventListener('change', (e) => e.target.files[0] && upload(e.target.files[0]))
const drop = $('drop')
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')))
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
	e.preventDefault()
	drop.classList.remove('over')
	if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0])
})

$('delete-confirm').addEventListener('input', () => ($('delete-account').disabled = $('delete-confirm').value.trim().toLowerCase() !== 'delete'))
$('delete-account').addEventListener('click', async () => {
	try {
		await change('/api/account', 'DELETE')
		location.href = '/'
	} catch (e) {
		say($('delete-msg'), e.message, false)
	}
})

// Without an account behind this copy of the site, there is nothing to set.
if ('hosted' in document.documentElement.dataset) load().catch((e) => say($('key-msg'), e.message, false))
else location.replace('dashboard.html')
