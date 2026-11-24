// The site is dark or light as the visitor chose with the switch. Until they
// choose, it follows their system. Each page loads this in <head>, so the
// theme is in place before the page is first drawn.
{
	const root = document.documentElement
	const KEY = 'teardrop-theme'
	const system = matchMedia('(prefers-color-scheme: light)')
	let chosen = null
	try {
		chosen = localStorage.getItem(KEY)
	} catch {
		// Storage is blocked, so a choice lasts for this page only.
	}
	const apply = () => {
		if (chosen ? chosen === 'light' : system.matches) root.dataset.theme = 'light'
		else delete root.dataset.theme
	}
	apply()
	// A system that changes, such as at sunset, takes the page with it.
	system.addEventListener('change', apply)
	document.addEventListener('click', (e) => {
		if (!e.target.closest?.('[data-theme-toggle]')) return
		chosen = root.dataset.theme === 'light' ? 'dark' : 'light'
		apply()
		try {
			localStorage.setItem(KEY, chosen)
		} catch {}
	})
}
