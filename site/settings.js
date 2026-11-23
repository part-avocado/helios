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
	$('me-role').textContent = (['Superadmin', 'Neoadmin', 'Reviewer'][me.level] ?? 'Member') + (me.ban ? '. Banned' : '')
	showBan(me.ban)
}

$('new-key').addEventListener('click', async () => {
	if (!confirm('Make a new account key? The old one stops working wherever you put it by hand, such as Amp cloud threads. Computers with keys of their own keep syncing.')) return
	try {
		const key = (await change('/api/key', 'POST')).api_key
		renderSetup($('setup-steps'), key)
		// The new key in a popup, to copy to wherever the old one was.
		$('new-key-value').textContent = key
		$('key-dialog').showModal()
		say($('key-msg'), 'New key made. The steps above now use it.', true)
	} catch (e) {
		say($('key-msg'), e.message, false)
	}
})

// The public profile: its handle, whether anyone can see it, and which projects it names.
function showProfile(p) {
	const url = `${location.origin}/@${p.handle}`
	$('profile-link').textContent = url.replace(/^https?:\/\//, '')
	$('profile-link').href = url
	$('handle').value = p.handle
	$('profile-public').checked = p.public
	// A private profile has no badge: it answers "not found", as the profile does.
	const badge = `${location.origin}/api/public/v1/users/${p.handle}/badge.svg`
	$('badge').hidden = !p.public
	$('badge-img').src = p.public ? `${badge}?v=${Date.now()}` : ''
	$('badge-md').textContent = `[![teardrop](${badge})](${url})`
	$('profile-projects').innerHTML = p.projects.map((x) => `<div class="item">
			<div class="grow"><b>${esc(x.name)}</b>
				<div class="sub">${x.repo ? esc(x.repo) : 'A folder on your computer'} - ${dur(x.engaged_seconds)}</div></div>
			<label class="check"><input type="checkbox" data-project="${esc(x.key)}"${x.shown ? ' checked' : ''}> Name it</label>
		</div>`).join('') || '<div class="item"><div class="grow muted">No projects yet. They appear here after your first sync.</div></div>'
}
const saveProfile = async (changes, done) => {
	try {
		showProfile(await change('/api/profile', 'POST', JSON.stringify(changes)))
		if (done) say($('profile-msg'), done, true)
		else $('profile-msg').hidden = true
	} catch (e) {
		say($('profile-msg'), e.message, false)
		showProfile(await api('/api/profile'))
	}
}
$('handle-form').addEventListener('submit', (e) => {
	e.preventDefault()
	saveProfile({ handle: $('handle').value }, 'Handle saved. Your profile has moved to the new address.')
})
$('profile-public').addEventListener('change', (e) => saveProfile({ public: e.target.checked }, e.target.checked ? 'Your profile is public.' : 'Your profile is private. Its address now says there is no such profile.'))
$('profile-projects').addEventListener('change', (e) => {
	const key = e.target.dataset.project
	if (key !== undefined) saveProfile({ projects: { [key]: e.target.checked } })
})

// Sync keys beside the account's own: one per computer that ran teardrop login, and any made here.
async function listSyncKeys() {
	const { keys } = await api('/api/sync-keys')
	$('sync-keys').innerHTML = keys.map((k) => `<div class="item">
			<div class="grow">${/^td-[0-9a-f]{12}$/.test(k.name) ? `Computer <code>${esc(k.name)}</code>` : `<b>${esc(k.name)}</b>`} <code>${esc(k.hint)}…</code>
				<div class="sub">Made ${esc(ago(k.created_at))} - ${k.last_used_at ? `last used ${esc(ago(k.last_used_at))}` : 'never used'}</div></div>
			<button class="btn small danger" type="button" data-revoke="${k.id}" data-name="${esc(k.name)}">Revoke</button>
		</div>`).join('') || '<div class="item"><div class="grow muted">No other sync keys. Each computer you connect with teardrop login adds one.</div></div>'
}
$('sync-key-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	try {
		const made = await change('/api/sync-keys', 'POST', JSON.stringify({ name: e.target.name.value }))
		e.target.reset()
		$('sync-key-msg').hidden = true
		$('sync-key-connect').textContent = `teardrop sync -server ${location.origin} -key ${made.key}`
		$('sync-dialog').showModal()
		await listSyncKeys()
	} catch (err) {
		say($('sync-key-msg'), err.message, false)
	}
})
$('sync-keys').addEventListener('click', async (e) => {
	const d = e.target.closest('[data-revoke]')?.dataset
	if (!d || !confirm(`Revoke the sync key "${d.name}"? Whatever uses it stops syncing at once.`)) return
	try {
		await change('/api/sync-keys/' + d.revoke, 'DELETE')
		await listSyncKeys()
	} catch (err) {
		say($('sync-key-msg'), err.message, false)
	}
})

// Read keys for the public API.
async function listKeys() {
	const { keys } = await api('/api/keys')
	$('api-keys').innerHTML = keys.map((k) => `<div class="item">
			<div class="grow"><b>${esc(k.name)}</b> <code>${esc(k.hint)}…</code>
				<div class="sub">${k.site ? `Signed in at ${esc(k.site)}, ` : 'Made '}${esc(ago(k.created_at))} - ${k.last_used_at ? `last used ${esc(ago(k.last_used_at))}` : 'never used'}</div></div>
			<button class="btn small danger" type="button" data-revoke="${k.id}" data-name="${esc(k.name)}">Revoke</button>
		</div>`).join('') || '<div class="item"><div class="grow muted">You have no read keys.</div></div>'
}
$('api-example').textContent = `curl -H "Authorization: Bearer $KEY" ${location.origin}/api/public/v1/projects`
$('api-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	try {
		const made = await change('/api/keys', 'POST', JSON.stringify({ name: e.target.name.value }))
		e.target.reset()
		$('api-msg').hidden = true
		$('api-key-value').textContent = made.key
		$('api-dialog').showModal()
		await listKeys()
	} catch (err) {
		say($('api-msg'), err.message, false)
	}
})
$('api-keys').addEventListener('click', async (e) => {
	const d = e.target.closest('[data-revoke]')?.dataset
	if (!d || !confirm(`Revoke the read key "${d.name}"? Whatever uses it stops working at once.`)) return
	try {
		await change('/api/keys/' + d.revoke, 'DELETE')
		await listKeys()
	} catch (err) {
		say($('api-msg'), err.message, false)
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
if ('hosted' in document.documentElement.dataset) {
	load().catch((e) => say($('key-msg'), e.message, false))
	listKeys().catch((e) => say($('api-msg'), e.message, false))
	listSyncKeys().catch((e) => say($('sync-key-msg'), e.message, false))
	api('/api/profile').then(showProfile, (e) => say($('profile-msg'), e.message, false))
}
else location.replace('dashboard.html')
