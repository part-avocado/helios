// The site is dark unless the visitor chose light. Each page loads this in
// <head>, so the choice is in place before the page is first drawn.
{
	const root = document.documentElement
	const KEY = 'teardrop-theme'
	try {
		if (localStorage.getItem(KEY) === 'light') root.dataset.theme = 'light'
	} catch {
		// Storage is blocked, so the choice lasts for this page only.
	}
	document.addEventListener('click', (e) => {
		if (!e.target.closest?.('[data-theme-toggle]')) return
		const light = root.dataset.theme !== 'light'
		if (light) root.dataset.theme = 'light'
		else delete root.dataset.theme
		try {
			localStorage.setItem(KEY, light ? 'light' : 'dark')
		} catch {}
	})
}
