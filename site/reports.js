// Reading helios reports, shared by the dashboard and the projects page.
// Needs t and LANG from i18n.js, and esc from account.js.

const count = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))

// verify checks a signed report from `helios dashboard` and returns its payload.
// The key is an Ed25519 signature of the payload text by the account inside it,
// so editing any number, the account, or a time makes it fail.
const SKEW = 5 * 60000
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
async function verify(file) {
	if (!file || typeof file.payload !== 'string' || typeof file.key !== 'string') {
		throw new Error(t('dash.err.noKey'))
	}
	let p
	try {
		p = JSON.parse(file.payload)
	} catch {
		throw new Error(t('dash.err.damaged'))
	}
	let ok = false
	try {
		const key = await crypto.subtle.importKey('raw', b64u(p.account), { name: 'Ed25519' }, false, ['verify'])
		ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64u(file.key), new TextEncoder().encode(file.payload))
	} catch (e) {
		if (!crypto.subtle) throw new Error(t('dash.err.insecure'))
		if (e?.name === 'NotSupportedError') throw new Error(t('dash.err.unsupported'))
	}
	if (!ok) throw new Error(t('dash.err.mismatch'))
	const generated = Date.parse(p.generated_at), expires = Date.parse(p.expires_at), now = Date.now()
	if (!(generated <= now + SKEW)) throw new Error(t('dash.err.future'))
	if (!(now <= expires)) throw new Error(t('dash.err.expired', { date: new Date(expires).toLocaleString(LANG) }))
	if ((p.report?.blocks || []).some((b) => Date.parse(b.end) > generated + SKEW)) {
		throw new Error(t('dash.err.afterMade'))
	}
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', b64u(p.account)))
	p.accountID = 'td-' + [...digest.slice(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join('')
	return p
}

const verifiedNote = (p) =>
	`<span class="tag ok" title="${esc(t('dash.verifiedTitle'))}"><svg class="ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>${t('dash.verified')}</span> ${t('dash.verifiedNote', { id: esc(p.accountID), date: esc(new Date(p.expires_at).toLocaleDateString(LANG)) })}`

// merge puts together the latest report of each of a person's computers.
// days are the account's own per-day totals, when the site sends them: there,
// time on two computers at once counts once, which adding the computers up
// can't know.
function merge(computers, days) {
	const reports = computers.map((c) => c.report.report || {})
	const perDay = new Map()
	for (const r of reports) for (const d of r.days || []) perDay.set(d.date, (perDay.get(d.date) || 0) + d.engaged_seconds)
	return {
		blocks: reports.flatMap((r) => r.blocks || []),
		projects: reports.flatMap((r) => r.projects || []),
		// Without per-day totals from every computer, render() adds up blocks instead.
		days: Array.isArray(days) ? days : reports.every((r) => Array.isArray(r.days)) ? [...perDay].map(([date, engaged_seconds]) => ({ date, engaged_seconds })) : undefined,
	}
}

// The ranges a page can show, in days, and the one it starts on.
const RANGES = [7, 30, 365]
const rangeFrom = (params) => (RANGES.includes(Number(params.get('days'))) ? Number(params.get('days')) : 30)
