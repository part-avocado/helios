// Charts shared by the dashboard and public profiles: the year of days, and
// the tooltip that follows the pointer over any element with data-tip.
// Needs esc and dur from account.js.
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
// Calendar days, not 24-hour steps, which land on the wrong day across a clock change.
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const fmtDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

// tipAttrs makes an element show the tooltip: a title, a line under it, and
// an optional hint about clicking.
const tipAttrs = (title, body, hint = '') => ` data-tip="${esc(title)}" data-body="${esc(body)}" data-hint="${esc(hint)}"`

// heatmapHTML draws a year of days, one column per week, like a contribution
// graph. perDay holds engaged seconds by dayKey. With clickable, days with
// activity can be clicked, and selected(day) marks the ones picked.
function heatmapHTML(perDay, now, { clickable = false, selected = () => false } = {}) {
	const end = startOfDay(now)
	const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 364 - end.getDay())
	const level = (s) => (s <= 0 ? 0 : s < 1800 ? 1 : s < 3600 ? 2 : s < 3 * 3600 ? 3 : 4)
	const cell = 13, gap = 3
	let rects = '', months = '', lastMonth = -1, col = 0
	for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
		const row = d.getDay()
		if (row === 0 && d > start) col++
		if (row === 0 && d.getMonth() !== lastMonth) {
			lastMonth = d.getMonth()
			months += `<text x="${30 + col * (cell + gap)}" y="10">${d.toLocaleString(undefined, { month: 'short' })}</text>`
		}
		const s = perDay.get(dayKey(d)) || 0
		const click = clickable && s > 0
		// The level's class colors the day, so the chart follows the dark or light theme.
		const cls = `l${level(s)}${click ? ' has' : ''}${click && selected(d) ? ' sel' : ''}`
		const attrs = click ? ` data-ts="${d.getTime()}" data-span="1"` : ''
		rects += `<rect class="${cls}" x="${30 + col * (cell + gap)}" y="${18 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2"${attrs}${tipAttrs(fmtDate.format(d), s ? dur(s) : 'No activity', click ? 'Click to see this day' : '')}/>`
	}
	const labels = ['Mon', 'Wed', 'Fri'].map((t, i) => `<text x="0" y="${18 + (i * 2 + 1) * (cell + gap) + 10}">${t}</text>`).join('')
	const w = 30 + (col + 1) * (cell + gap)
	const h = 18 + 7 * (cell + gap)
	// Drawn to fill its panel, and no smaller than its own size, below which its box scrolls.
	return `<svg viewBox="0 0 ${w} ${h}" style="min-width:${w}px" role="img" aria-label="Engaged time per day over the last year">${months}${labels}${rects}</svg>`
}

// initTips shows the page's tooltip (#tip) over the elements with data-tip
// inside container: one box that follows the pointer, and sits above a
// focused element.
function initTips(container) {
	const tipBox = document.getElementById('tip')
	function showTip(el) {
		tipBox.querySelector('b').textContent = el.dataset.tip
		tipBox.querySelector('span').textContent = el.dataset.body
		tipBox.querySelector('em').textContent = el.dataset.hint
		tipBox.querySelector('em').hidden = !el.dataset.hint
		tipBox.hidden = false
	}
	function moveTip(x, y) {
		const box = tipBox.getBoundingClientRect()
		let left = x + 14, top = y - box.height - 12
		if (left + box.width > innerWidth - 8) left = x - box.width - 14
		if (top < 8) top = y + 20
		tipBox.style.transform = `translate(${Math.round(Math.max(8, left))}px, ${Math.round(top)}px)`
	}
	const hideTip = () => (tipBox.hidden = true)
	container.addEventListener('pointermove', (e) => {
		const el = e.target.closest('[data-tip]')
		if (!el) return hideTip()
		showTip(el)
		moveTip(e.clientX, e.clientY)
	})
	container.addEventListener('pointerleave', hideTip)
	container.addEventListener('focusin', (e) => {
		const el = e.target.closest('[data-tip]')
		if (!el) return
		showTip(el)
		const r = el.getBoundingClientRect()
		moveTip(r.left + r.width / 2, r.top)
	})
	container.addEventListener('focusout', hideTip)
	document.addEventListener('pointerdown', (e) => container.contains(e.target) || hideTip())
	addEventListener('scroll', hideTip, { passive: true })
}
