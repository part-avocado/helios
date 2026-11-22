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

// Docs: search. Each heading starts a section, and typing lists the sections
// that hold every word typed, the ones that name it in their heading first.
// ⌘K or Ctrl K opens it.
const search = document.getElementById('doc-search')
if (search) {
	const results = document.getElementById('doc-results')
	const toc = document.querySelector('.doc-toc')
	const mac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '')
	search.nextElementSibling.textContent = mac ? '⌘K' : 'Ctrl K'
	const sections = []
	let anchor = ''
	let chapter = ''
	for (const el of document.querySelectorAll('.docs article > *')) {
		if (/^H[1-3]$/.test(el.tagName)) {
			if (el.id) anchor = el.id
			const title = el.textContent.trim()
			sections.push({ title, id: anchor, chapter: el.tagName === 'H3' ? chapter : '', text: '' })
			if (el.tagName === 'H2') chapter = title
		} else if (sections.length) {
			sections.at(-1).text += ' ' + el.textContent.replace(/\s+/g, ' ')
		}
	}
	const esc = (t) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
	const mark = (t, words) => esc(t).replace(new RegExp(`(${words.map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'), '<mark>$1</mark>')
	// snippet is the text around a word typed, cut at whole words.
	const snippet = (text, words) => {
		text = text.trim()
		const lower = text.toLowerCase()
		// The first word typed that the text holds, since people type the word they care about first.
		const hit = words.map((w) => lower.indexOf(w)).find((i) => i >= 0) ?? -1
		if (hit < 50) return text.slice(0, 140).replace(/\s+\S*$/, '') + (text.length > 140 ? '…' : '')
		const from = text.lastIndexOf(' ', hit - 30) + 1
		const cut = text.slice(from, from + 140)
		return '…' + (from + 140 < text.length ? cut.replace(/\s+\S*$/, '') + '…' : cut)
	}
	let picked = 0
	const pick = (i) => {
		const all = [...results.querySelectorAll('a')]
		picked = Math.max(0, Math.min(i, all.length - 1))
		all.forEach((a, j) => a.setAttribute('aria-selected', String(j === picked)))
		all[picked]?.scrollIntoView({ block: 'nearest' })
	}
	const show = () => {
		const words = search.value.toLowerCase().split(/\s+/).filter(Boolean)
		results.hidden = !words.length
		toc.hidden = !!words.length
		if (!words.length) return
		const found = sections
			.map((s) => ({ ...s, score: words.every((w) => (s.title + s.text).toLowerCase().includes(w)) ? words.filter((w) => s.title.toLowerCase().includes(w)).length + 1 : 0 }))
			.filter((s) => s.score)
			.sort((a, b) => b.score - a.score)
			.slice(0, 12)
		results.innerHTML = found.length
			? `<p class="count">${found.length === 1 ? '1 section' : `${found.length} sections`}</p>` +
				found.map((s) => `<a href="#${esc(s.id)}" role="option">${s.chapter ? `<span>${esc(s.chapter)}</span>` : ''}<b>${mark(s.title, words)}</b><small>${mark(snippet(s.text, words), words)}</small></a>`).join('')
			: '<p class="none">Nothing matches. Try fewer words.</p>'
		pick(0)
	}
	search.addEventListener('input', show)
	search.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault()
			pick(picked + (e.key === 'ArrowDown' ? 1 : -1))
		} else if (e.key === 'Enter') {
			results.querySelectorAll('a')[picked]?.click()
		} else if (e.key === 'Escape') {
			search.value = ''
			show()
		}
	})
	// Opening a result keeps the search, so the next one is a click away.
	results.addEventListener('click', (e) => e.target.closest('a') && search.blur())
	document.addEventListener('keydown', (e) => {
		if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
			e.preventDefault()
			search.focus()
			search.select()
		}
	})
}

// The account menu closes when the visitor clicks elsewhere or presses Escape.
for (const menu of document.querySelectorAll('details.account')) {
	document.addEventListener('click', (e) => menu.open && !menu.contains(e.target) && (menu.open = false))
	menu.addEventListener('keydown', (e) => e.key === 'Escape' && ((menu.open = false), menu.querySelector('summary').focus()))
}
