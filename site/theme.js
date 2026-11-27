// The site is dark unless the visitor chose light with the switch. Each page
// loads this in <head>, so the theme is in place before the page is first drawn.
{
	const root = document.documentElement
	const KEY = 'helios-theme'
	let chosen = null
	try {
		chosen = localStorage.getItem(KEY)
	} catch {
		// Storage is blocked, so a choice lasts for this page only.
	}
	const apply = () => {
		if (chosen === 'light') root.dataset.theme = 'light'
		else delete root.dataset.theme
	}
	apply()
	document.addEventListener('click', (e) => {
		if (!e.target.closest?.('[data-theme-toggle]')) return
		chosen = root.dataset.theme === 'light' ? 'dark' : 'light'
		apply()
		try {
			localStorage.setItem(KEY, chosen)
		} catch {}
	})
}
