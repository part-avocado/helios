// Shared behavior: OS tabs that pick the visitor's OS, and copy buttons.
function initTabs(root = document) {
	for (const box of root.querySelectorAll('[data-tabs]')) {
		const buttons = [...box.querySelectorAll('.tabs button')]
		const select = (name) => {
			for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.tab === name))
			for (const p of box.querySelectorAll('.tab-panel')) p.hidden = p.dataset.tab !== name
		}
		for (const b of buttons) b.addEventListener('click', () => select(b.dataset.tab))
		const platform = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase()
		select(box.dataset.default || (platform.includes('win') ? 'windows' : platform.includes('mac') ? 'mac' : 'linux'))
	}
}
initTabs()

// Copy buttons copy the command next to them, including ones added to the page later.
document.addEventListener('click', async (e) => {
	const btn = e.target.closest?.('.copy')
	if (!btn) return
	const text = btn.parentElement.querySelector('code').textContent
	try {
		await navigator.clipboard.writeText(text)
		btn.textContent = 'Copied'
	} catch {
		btn.textContent = 'Select and copy'
	}
	setTimeout(() => (btn.textContent = 'Copy'), 1500)
})

// Docs: highlight the sidebar link of the section in view.
const links = [...document.querySelectorAll('.docs aside a[href^="#"]')]
if (links.length) {
	const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]))
	const observer = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue
				for (const a of links) a.classList.remove('active')
				byId.get(e.target.id)?.classList.add('active')
			}
		},
		{ rootMargin: '-80px 0px -70% 0px' },
	)
	for (const id of byId.keys()) {
		const el = document.getElementById(id)
		if (el) observer.observe(el)
	}
}

// The account menu closes when the visitor clicks elsewhere or presses Escape.
for (const menu of document.querySelectorAll('details.account')) {
	document.addEventListener('click', (e) => menu.open && !menu.contains(e.target) && (menu.open = false))
	menu.addEventListener('keydown', (e) => e.key === 'Escape' && ((menu.open = false), menu.querySelector('summary').focus()))
}
