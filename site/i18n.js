// Translations. Every string the pages show lives in strings.json, one object
// per language, and this loads in each page's <head> before anything else.
//
// A page's own scripts are listed in this tag's data-scripts, and run once
// the strings have arrived, so they can call t() at the top level:
//   <script src="i18n.js" data-scripts="site.js dashboard.js"></script>
//
// In the markup:
//   data-i18n="key"                       sets the element's HTML to the string
//   data-i18n-attr="aria-label:key;..."   sets attributes
// In scripts:
//   t('key', { name: 'x' })               fills {name}; params are NOT escaped, so esc() ones that go into HTML
//   tn('key', 3, { ... })                 picks key_one or key_other for the count, and fills {n}
//
// The language is the one chosen with the switch in the nav, else the
// browser's if it is supported, else English. To add a language, add an
// object to strings.json and its code to LANGUAGES. A missing string shows
// in English.
const LANGUAGES = ['en', 'ja']
const FALLBACK = 'en'
let LANG = FALLBACK
let STRINGS = {}

function t(key, params) {
	const text = STRINGS[LANG]?.[key] ?? STRINGS[FALLBACK]?.[key] ?? key
	// Only the names given are filled, so a {braced} word in a string stays as written.
	return params ? text.replace(/\{(\w+)\}/g, (all, name) => (name in params ? params[name] : all)) : text
}

// tn is t for a count: key_one when the language says the count takes the singular, key_other otherwise.
function tn(key, n, params) {
	const form = new Intl.PluralRules(LANG).select(n) === 'one' ? 'one' : 'other'
	return t(`${key}_${form}`, { n, ...params })
}

{
	const KEY = 'helios-lang'
	const root = document.documentElement
	const self = document.currentScript
	let chosen = null
	try {
		chosen = localStorage.getItem(KEY)
	} catch {
		// Storage is blocked, so a choice lasts for this page only.
	}
	const browser = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => LANGUAGES.includes(l))
	LANG = LANGUAGES.includes(chosen) ? chosen : browser || FALLBACK
	root.lang = LANG
	// Until the strings are in, a page that is not in English stays hidden rather than flash its English.
	if (LANG !== FALLBACK) root.dataset.i18nPending = ''
	const reveal = () => delete root.dataset.i18nPending
	setTimeout(reveal, 3000)

	const apply = () => {
		for (const el of document.querySelectorAll('[data-i18n]')) el.innerHTML = t(el.dataset.i18n)
		for (const el of document.querySelectorAll('[data-i18n-attr]')) {
			for (const pair of el.dataset.i18nAttr.split(';')) {
				const [attr, key] = pair.split(':')
				el.setAttribute(attr.trim(), t(key.trim()))
			}
		}
		for (const button of document.querySelectorAll('[data-lang-toggle]')) {
			// It names the language it switches to, in that language.
			const next = LANGUAGES[(LANGUAGES.indexOf(LANG) + 1) % LANGUAGES.length]
			button.textContent = STRINGS[next]?.['lang.name'] ?? next
			button.setAttribute('aria-label', t('lang.switch'))
			button.title = t('lang.switch')
			button.lang = next
			button.onclick = () => {
				try {
					localStorage.setItem(KEY, next)
				} catch {}
				location.reload()
			}
		}
		for (const el of document.querySelectorAll('[data-not-english]')) el.hidden = LANG === FALLBACK
	}

	// The page's scripts, in order, from the folder this one is in.
	const run = (names) => {
		for (const name of names) {
			const s = document.createElement('script')
			s.src = new URL(name, self.src).href
			s.async = false // scripts added from script run as they arrive, unless told to keep their order
			document.head.append(s)
		}
	}
	const scripts = (self.dataset.scripts || '').split(/\s+/).filter(Boolean)
	const loaded = fetch(new URL('strings.json', self.src)).then((r) => r.json()).then((all) => (STRINGS = all), (e) => console.error('helios: could not load strings.json', e))
	const parsed = document.readyState === 'loading' ? new Promise((done) => document.addEventListener('DOMContentLoaded', done, { once: true })) : Promise.resolve()
	Promise.all([loaded, parsed]).then(() => {
		apply()
		reveal()
		run(scripts)
	})
}
