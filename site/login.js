// Carry on to the page the visitor asked for, and say why a sign-in didn't work.
const query = new URLSearchParams(location.search)
if (query.get('next')) document.getElementById('go').href += '?next=' + encodeURIComponent(query.get('next'))
const failure = query.get('error')
if (['expired', 'cancelled', 'failed', 'setup'].includes(failure)) {
	document.getElementById('error').textContent = t(`login.err.${failure}`)
	document.getElementById('error').hidden = false
}
