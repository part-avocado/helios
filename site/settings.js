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

// ask puts a question in a popup and answers whether the visitor agreed.
// Cancel has the focus, and Escape is a no. danger marks an action that
// can't be undone.
function ask(title, text, action, danger = true) {
	const dialog = $('confirm-dialog')
	$('confirm-title').textContent = title
	$('confirm-text').textContent = text
	$('confirm-go').textContent = action
	$('confirm-go').className = 'btn small ' + (danger ? 'danger fill' : 'primary')
	dialog.returnValue = 'no'
	dialog.showModal()
	return new Promise((done) => dialog.addEventListener('close', () => done(dialog.returnValue === 'yes'), { once: true }))
}

// during keeps a button from being pressed again while its request is on the way.
async function during(button, work) {
	button.disabled = true
	button.setAttribute('aria-busy', 'true')
	try {
		return await work()
	} finally {
		button.disabled = false
		button.removeAttribute('aria-busy')
	}
}

// unloaded says so in each place that was still waiting for what could not be loaded.
function unloaded(...ids) {
	for (const id of ids) for (const el of $(id).querySelectorAll('.skeleton')) el.replaceWith(t('common.loadFailed'))
}

// The API only takes changes from this site's own pages, which the browser
// vouches for with the Origin header it adds to these requests.
const change = (path, method, body) => api(path, { method, body })

function listComputers(computers) {
	$('computer-list').innerHTML = computers.map((c) => `<div class="item">
			<div class="grow">${c.cloud ? `${t('settings.computers.amp')} ` : ''}<code>${esc(c.id)}</code>
				<div class="sub">${t('settings.computers.synced', { ago: esc(ago(c.synced_at)), time: dur(c.engaged_seconds) })}${c.teardrop_version ? t('settings.computers.version', { version: esc(c.teardrop_version) }) : ''}</div></div>
			<button class="btn small danger" type="button" data-remove="${esc(c.id)}">${t('common.remove')}</button>
		</div>`).join('') ||
		`<div class="item"><div class="grow muted">${t('settings.computers.none')}</div></div>`
}

// With a computer connected already, Setup is for adding another: the
// command and the code, with the rest folded away.
let another = false
function showSetup(key) {
	const h2 = $('setup').querySelector('h2'), lead = $('setup').querySelector('h2 + .muted')
	h2.textContent = t(another ? 'settings.setup.again.h2' : 'settings.setup.h2')
	lead.textContent = t(another ? 'settings.setup.again.lead' : 'settings.setup.lead')
	renderSetup($('setup-steps'), key, another)
}

async function load() {
	const me = await api('/api/me')
	another = me.computers.length > 0
	showSetup(me.api_key)
	listComputers(me.computers)
	$('me-name').textContent = me.name || t('common.notSet')
	$('me-slack').textContent = me.slack_id || t('settings.account.noSlack')
	$('me-since').textContent = new Intl.DateTimeFormat(LANG, { dateStyle: 'long' }).format(me.created_at)
	$('me-role').textContent = t(`settings.account.role.${['superadmin', 'neoadmin', 'reviewer'][me.level] ?? 'member'}`) + (me.ban ? t('settings.account.banned') : '')
	showBan(me.ban)
}

$('new-key').addEventListener('click', async () => {
	if (!(await ask(t('settings.acctKey.askTitle'), t('settings.acctKey.askText'), t('settings.acctKey.askGo')))) return
	try {
		const key = (await change('/api/key', 'POST')).api_key
		showSetup(key)
		// The new key in a popup, to copy to wherever the old one was.
		$('new-key-value').textContent = key
		$('key-dialog').showModal()
		say($('key-msg'), t('settings.acctKey.made'), true)
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
				<div class="sub">${x.repo ? esc(x.repo) : t('settings.profile.folder')} · ${dur(x.engaged_seconds)}</div></div>
			<label class="check"><input type="checkbox" data-project="${esc(x.key)}"${x.shown ? ' checked' : ''}> ${t('settings.profile.nameIt')}</label>
		</div>`).join('') || `<div class="item"><div class="grow muted">${t('settings.profile.noProjects')}</div></div>`
}
const saveProfile = async (changes, done) => {
	try {
		showProfile(await change('/api/profile', 'POST', JSON.stringify(changes)))
		if (done) say($('profile-msg'), done, true)
		else $('profile-msg').hidden = true
	} catch (e) {
		say($('profile-msg'), e.message, false)
		// Back to what is saved, except a handle that was refused, which stays to be corrected.
		const typed = $('handle').value
		showProfile(await api('/api/profile'))
		if ('handle' in changes) $('handle').value = typed
	}
}
$('handle-form').addEventListener('submit', (e) => {
	e.preventDefault()
	during(e.target.querySelector('button'), () => saveProfile({ handle: $('handle').value }, t('settings.profile.handleSaved')))
})
$('profile-public').addEventListener('change', (e) => saveProfile({ public: e.target.checked }, e.target.checked ? t('settings.profile.nowPublic') : t('settings.profile.nowPrivate')))
$('profile-projects').addEventListener('change', (e) => {
	const key = e.target.dataset.project
	if (key !== undefined) saveProfile({ projects: { [key]: e.target.checked } })
})

// lastUsed says when a key was last used, as HTML.
const lastUsed = (k) => (k.last_used_at ? t('settings.key.lastUsed', { ago: esc(ago(k.last_used_at)) }) : t('settings.key.neverUsed'))

// Sync keys beside the account's own: one per computer that ran teardrop login, and any made here.
async function listSyncKeys() {
	const { keys } = await api('/api/sync-keys')
	$('sync-keys').innerHTML = keys.map((k) => `<div class="item">
			<div class="grow">${/^td-[0-9a-f]{12}$/.test(k.name) ? t('settings.sync.computer', { id: esc(k.name) }) : `<b>${esc(k.name)}</b>`} <code>${esc(k.hint)}…</code>
				<div class="sub">${t('settings.key.madeLine', { ago: esc(ago(k.created_at)), used: lastUsed(k) })}</div></div>
			<button class="btn small danger" type="button" data-revoke="${k.id}" data-name="${esc(k.name)}">${t('common.revoke')}</button>
		</div>`).join('') || `<div class="item"><div class="grow muted">${t('settings.sync.none')}</div></div>`
}
$('sync-key-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	try {
		const made = await during(e.target.querySelector('button'), () => change('/api/sync-keys', 'POST', JSON.stringify({ name: e.target.name.value })))
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
	if (!d || !(await ask(t('settings.sync.revokeTitle'), t('settings.sync.revokeText', { name: d.name }), t('common.revoke')))) return
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
				<div class="sub">${k.site ? t('settings.api.signedInAt', { site: esc(k.site), ago: esc(ago(k.created_at)) }) : t('settings.api.made', { ago: esc(ago(k.created_at)) })} · ${lastUsed(k)}</div></div>
			<button class="btn small danger" type="button" data-revoke="${k.id}" data-name="${esc(k.name)}">${t('common.revoke')}</button>
		</div>`).join('') || `<div class="item"><div class="grow muted">${t('settings.api.none')}</div></div>`
}
$('api-example').textContent = `curl -H "Authorization: Bearer $KEY" ${location.origin}/api/public/v1/projects`
$('api-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	try {
		const made = await during(e.target.querySelector('button'), () => change('/api/keys', 'POST', JSON.stringify({ name: e.target.name.value })))
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
	if (!d || !(await ask(t('settings.api.revokeTitle'), t('settings.api.revokeText', { name: d.name }), t('common.revoke')))) return
	try {
		await change('/api/keys/' + d.revoke, 'DELETE')
		await listKeys()
	} catch (err) {
		say($('api-msg'), err.message, false)
	}
})

$('computer-list').addEventListener('click', async (e) => {
	const id = e.target.closest('[data-remove]')?.dataset.remove
	if (!id || !(await ask(t('settings.computers.removeTitle'), t('settings.computers.removeText', { id }), t('common.remove')))) return
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
		msg.innerHTML = t('settings.upload.added', { computer: esc(computer) })
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

$('delete-confirm').addEventListener('input', () => ($('delete-account').disabled = $('delete-confirm').value.trim().toLowerCase() !== t('settings.delete.word')))
$('delete-account').addEventListener('click', async (e) => {
	try {
		await during(e.currentTarget, () => change('/api/account', 'DELETE'))
		location.href = '/'
	} catch (e) {
		say($('delete-msg'), e.message, false)
	}
})

// Without an account behind this copy of the site, there is nothing to set.
if ('hosted' in document.documentElement.dataset) {
	load().catch((e) => (say($('key-msg'), e.message, false), unloaded('setup-steps', 'computer-list', 'account')))
	listKeys().catch((e) => (say($('api-msg'), e.message, false), unloaded('api-keys')))
	listSyncKeys().catch((e) => (say($('sync-key-msg'), e.message, false), unloaded('sync-keys')))
	api('/api/profile').then(showProfile, (e) => (say($('profile-msg'), e.message, false), unloaded('profile-projects')))
}
else location.replace('dashboard.html')
