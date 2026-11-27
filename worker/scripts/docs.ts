// npm run docs: writes the docs page, ../site/docs.html, from the Markdown
// pages in ../docs. docs/README.md lists the pages in order, under the groups
// the page's contents show; each other .md file is one section of the page.
//
//   node worker/scripts/docs.ts           write site/docs.html
//   node worker/scripts/docs.ts --check   exit 1 if site/docs.html is out of date
//
// Only the parts of docs.html between the docs:toc and docs:article comments
// are written; the rest of that file (the nav, the search box, the footer) is
// edited there, like any other page.
//
// The page is committed, because the Go binary embeds it (site/site.go), and
// `go install` builds from the repository as it is. test/docs.test.ts fails
// when it is out of date.
//
// This reads the Markdown the pages use and no more, and stops with the file
// and line of anything else, rather than put text on the site as it was not
// meant. docs/README.md says what that Markdown is.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const ROOT = new URL('../../', import.meta.url)
const DOCS = new URL('docs/', ROOT)
const PAGE = new URL('site/docs.html', ROOT)

class DocsError extends Error {}
const fail = (where: string, what: string): never => {
	throw new DocsError(`${where}: ${what}`)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attr = (s: string) => esc(s).replace(/"/g, '&quot;')

/** What a link in a page may point at, and what it becomes on the one-page site. */
type Links = { pages: Map<string, string>; used: { where: string; id: string }[] }

function href(url: string, links: Links, where: string): string {
	if (/^(https?:|mailto:)/.test(url)) return url
	// A bare domain, as in [ampcode.com](ampcode.com), is a web address without its https://.
	if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(url) && !/\.(md|html)(#|$)/i.test(url)) return `https://${url}`
	if (url.startsWith('#')) {
		links.used.push({ where, id: url.slice(1) })
		return url
	}
	// A page of the site, which is a file in ../site from here.
	if (url.startsWith('../site/')) return url.slice('../site/'.length)
	const [, file, frag] = /^([\w-]+\.md)(?:#(.+))?$/.exec(url) ?? fail(where, `the link to "${url}" is not to another page here (name.md), a heading (#id), a page of the site (../site/name.html), or a web address`)
	const id = links.pages.get(file!) ?? fail(where, `the link to "${url}" names a page that is not in docs/README.md`)
	links.used.push({ where, id: frag ?? id })
	return `#${frag ?? id}`
}

/** inline turns one block's text into HTML: `code`, **bold**, *emphasis*, [links](to), and \ before a character to write it as it is. */
function inline(s: string, links: Links, where: string): string {
	let out = ''
	for (let i = 0; i < s.length; ) {
		const c = s[i]!
		if (c === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1]!)) {
			out += esc(s[i + 1]!)
			i += 2
		} else if (c === '`') {
			const ticks = /^`+/.exec(s.slice(i))![0]
			const end = s.indexOf(ticks, i + ticks.length)
			if (end < 0) fail(where, `a \` is never closed in "${s.slice(i, i + 40)}"`)
			let code = s.slice(i + ticks.length, end)
			if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1)
			out += `<code>${esc(code)}</code>`
			i = end + ticks.length
		} else if (s.startsWith('**', i)) {
			const end = s.indexOf('**', i + 2)
			if (end < 0) fail(where, `a ** is never closed in "${s.slice(i, i + 40)}"`)
			out += `<strong>${inline(s.slice(i + 2, end), links, where)}</strong>`
			i = end + 2
		} else if (c === '*' && /\S/.test(s[i + 1] ?? ' ')) {
			const end = s.indexOf('*', i + 1)
			if (end < 0) fail(where, `a * is never closed in "${s.slice(i, i + 40)}"; write \\* for a star`)
			out += `<em>${inline(s.slice(i + 1, end), links, where)}</em>`
			i = end + 1
		} else if (c === '[') {
			// The matching ], past any code or brackets in the link's text.
			let end = -1
			for (let j = i + 1, depth = 0; j < s.length; j++) {
				if (s[j] === '\\') j++
				else if (s[j] === '`') j = s.indexOf('`', j + 1) < 0 ? s.length : s.indexOf('`', j + 1)
				else if (s[j] === '[') depth++
				else if (s[j] === ']' && depth-- === 0) {
					end = j
					break
				}
			}
			const close = end < 0 || s[end + 1] !== '(' ? -1 : s.indexOf(')', end + 2)
			if (close < 0) fail(where, `"${s.slice(i, i + 40)}" starts a link with no (address) after it; write \\[ for a bracket`)
			out += `<a href="${attr(href(s.slice(end + 2, close).trim(), links, where))}">${inline(s.slice(i + 1, end), links, where)}</a>`
			i = close + 1
		} else if (c === '!' && s[i + 1] === '[') {
			fail(where, 'images are not supported')
		} else {
			out += esc(c)
			i++
		}
	}
	return out
}

const ICONS = {
	note: '<path fill="currentColor" d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>',
	warning: '<path fill="currentColor" d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>',
}
/** The > [!NOTE] kinds GitHub draws that the site has a style for (.callout in site/style.css). */
const CALLOUTS: Record<string, { cls: string; title: string; icon: string }> = {
	NOTE: { cls: 'note', title: 'Note', icon: ICONS.note },
	IMPORTANT: { cls: 'important', title: 'Important', icon: ICONS.note },
	WARNING: { cls: 'warning', title: 'Warning', icon: ICONS.warning },
}

/** cells splits a table row at each |, as GitHub does: \| is a | in the cell, also inside code. */
function cells(line: string): string[] {
	const row = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
	return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

const ITEM = /^(-|\*|\d+\.) +(.*)$/
const ANCHOR = /^<a id="([\w-]+)"><\/a>$/
const starts = (line: string) => /^(#{1,6} |```|>|\|)/.test(line) || ITEM.test(line) || ANCHOR.test(line)

type Built = { html: string[]; ids: { where: string; id: string }[]; title: string }

/**
 * blocks turns one Markdown file into the page's HTML, one block a line.
 * Headings sit `down` levels lower on the page than in the file. An
 * <a id="x"></a> line names the heading after it; the file's first heading
 * is otherwise named `id`.
 */
function blocks(file: string, text: string, down: number, id: string, links: Links): Built {
	const lines = text.split('\n')
	const built: Built = { html: [], ids: [], title: '' }
	let named = ''
	let i = 0
	const at = () => `docs/${file}:${i + 1}`
	const more = () => i < lines.length && lines[i]!.trim() !== ''
	while (i < lines.length) {
		const line = lines[i]!
		const where = at()
		if (line.trim() === '') {
			i++
		} else if (ANCHOR.test(line)) {
			named = ANCHOR.exec(line)![1]!
			i++
		} else if (/^#{1,6} /.test(line)) {
			const [, marks, title] = /^(#+) +(.*?)\s*$/.exec(line)!
			const level = marks!.length + down
			if (level > 4) fail(where, `${marks} is a deeper heading than the page has; use # to ${'#'.repeat(4 - down)}`)
			const first = built.title === ''
			if (marks!.length === 1 && !first) fail(where, 'a page has one # heading, its title; use ## for the headings under it')
			if (marks!.length !== 1 && first) fail(where, 'a page starts with its title, a # heading')
			const name = named || (first ? id : '')
			if (first) built.title = title!
			if (name) built.ids.push({ where, id: name })
			built.html.push(`${first && down ? '\n' : ''}\t<h${level}${name ? ` id="${attr(name)}"` : ''}>${inline(title!, links, where)}</h${level}>`)
			named = ''
			i++
		} else if (line.startsWith('```')) {
			const code: string[] = []
			for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) code.push(lines[i]!)
			if (i === lines.length) fail(where, 'this ``` is never closed')
			i++
			// No line break before </code>: the Copy button copies the text as it is.
			built.html.push(`\t<pre><code>${esc(code.join('\n'))}</code></pre>`)
		} else if (ITEM.test(line)) {
			const ordered = /^\d/.test(line)
			const items: string[] = []
			while (i < lines.length) {
				const m = ITEM.exec(lines[i]!)
				if (!m || /^\d/.test(lines[i]!) !== ordered) break
				let item = m[2]!
				// An item runs on over indented lines.
				for (i++; i < lines.length && /^\s+\S/.test(lines[i]!); i++) {
					if (ITEM.test(lines[i]!.trim())) fail(at(), 'a list inside a list is not supported')
					item += ' ' + lines[i]!.trim()
				}
				items.push(`\t\t<li>${inline(item, links, where)}</li>`)
				// A blank line between two items keeps them one list.
				if (lines[i]?.trim() === '' && ITEM.test(lines[i + 1] ?? '')) i++
			}
			const tag = ordered ? 'ol' : 'ul'
			built.html.push(`\t<${tag}>\n${items.join('\n')}\n\t</${tag}>`)
		} else if (line.startsWith('|')) {
			if (!/^\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?$/.test(lines[i + 1] ?? '')) fail(where, 'a table needs a line of | --- | under its first row')
			const head = cells(line)
			const rows = [`\t\t<tr>${head.map((c) => `<th>${inline(c, links, where)}</th>`).join('')}</tr>`]
			for (i += 2; more() && lines[i]!.startsWith('|'); i++) {
				const row = cells(lines[i]!)
				if (row.length !== head.length) fail(at(), `this row has ${row.length} cells and the table has ${head.length} columns; write \\| for a | in a cell`)
				rows.push(`\t\t<tr>${row.map((c) => `<td>${inline(c, links, at())}</td>`).join('')}</tr>`)
			}
			built.html.push(`\t<table>\n${rows.join('\n')}\n\t</table>`)
		} else if (line.startsWith('>')) {
			const quoted: string[] = []
			for (; more() && lines[i]!.startsWith('>'); i++) quoted.push(lines[i]!.replace(/^> ?/, ''))
			// Any case, as GitHub reads it: [!Warning] is [!WARNING].
			const kind = /^\[!(\w+)\]\s*$/.exec(quoted[0]!)?.[1]?.toUpperCase()
			const paragraphs = (kind ? quoted.slice(1) : quoted).join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${inline(p.replace(/\n/g, ' '), links, where)}</p>`).join('')
			if (!kind) built.html.push(`\t<blockquote>${paragraphs}</blockquote>`)
			else {
				const callout = CALLOUTS[kind] ?? fail(where, `[!${kind}] is not one of ${Object.keys(CALLOUTS).map((k) => `[!${k}]`).join(', ')}`)
				built.html.push(`\t<div class="callout ${callout.cls}"><p class="callout-title"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${callout.icon}</svg>${callout.title}</p>${paragraphs}</div>`)
			}
		} else {
			if (line.startsWith('<')) fail(where, 'HTML is not supported, apart from an <a id="name"></a> line before a heading; write \\< for a <')
			const text = [line.trim()]
			for (i++; more() && !starts(lines[i]!); i++) text.push(lines[i]!.trim())
			built.html.push(`\t<p>${inline(text.join(' '), links, where)}</p>`)
		}
	}
	if (named) fail(`docs/${file}`, `<a id="${named}"></a> has no heading after it`)
	return built
}

/** The id a page's title gets: the <a id> line before it, or the file's name. */
function pageId(file: string, text: string): string {
	const top = text.split('\n').filter((l) => l.trim())
	return ANCHOR.exec(top[0] ?? '')?.[1] ?? file.replace(/\.md$/, '')
}

function build(): { toc: string; article: string } {
	const read = (file: string) => readFileSync(new URL(file, DOCS), 'utf8').replace(/\r\n/g, '\n')
	const files = readdirSync(DOCS).filter((f) => f.endsWith('.md') && f !== 'README.md')
	const texts = new Map(files.map((f) => [f, read(f)]))
	const links: Links = { pages: new Map(files.map((f) => [f, pageId(f, texts.get(f)!)])), used: [] }

	// The index: its title and first paragraph open the page, and each ## with
	// a list of links under it is a group of the contents.
	const index = read('README.md').split('\n')
	const title = /^# +(.*)$/.exec(index[0] ?? '')?.[1] ?? fail('docs/README.md:1', 'the first line is the page title, a # heading')
	const groups: { name: string; items: string[] }[] = []
	const lead: string[] = []
	const order: string[] = []
	index.forEach((line, n) => {
		const where = `docs/README.md:${n + 1}`
		const group = /^## +(.*?)\s*$/.exec(line)
		const item = /^- +\[(.+)\]\((.+)\)\s*$/.exec(line)
		if (group) groups.push({ name: group[1]!, items: [] })
		else if (item && groups.length) {
			const file = item[2]!.split('#')[0]!
			if (!order.includes(file)) order.push(file)
			groups.at(-1)!.items.push(`\t<a href="${attr(href(item[2]!, links, where))}">${inline(item[1]!, links, where)}</a>`)
		} else if (n > 0 && !groups.length && (line.trim() || lead.length)) lead.push(line.trim())
	})
	for (const f of files) if (!order.includes(f)) fail(`docs/${f}`, 'this page is not listed in docs/README.md, so it has no place on the site')
	const toc = groups.filter((g) => g.items.length).map((g) => `\t<div class="group">${esc(g.name)}</div>\n${g.items.join('\n')}\n`).join('')

	const article = [`\t<h1>${inline(title, links, 'docs/README.md:1')}</h1>`, `\t<p class="muted">${inline(lead.join(' ').trim(), links, 'docs/README.md')}</p>`]
	const ids: { where: string; id: string }[] = []
	for (const file of order) {
		const page = blocks(file, texts.get(file)!, 1, links.pages.get(file)!, links)
		if (!page.title) fail(`docs/${file}`, 'a page starts with its title, a # heading')
		article.push(...page.html)
		ids.push(...page.ids)
	}
	const seen = new Map<string, string>()
	for (const { where, id } of ids) {
		if (seen.has(id)) fail(where, `the id "${id}" is also the heading at ${seen.get(id)}`)
		seen.set(id, where)
	}
	for (const { where, id } of links.used) if (!seen.has(id)) fail(where, `the link to #${id} goes to no heading; name one with an <a id="${id}"></a> line before it`)
	return { toc, article: article.join('\n') + '\n' }
}

/** fill replaces what lies between the <!-- docs:name --> and <!-- /docs:name --> comments of the page. */
function fill(page: string, name: string, body: string): string {
	const between = new RegExp(`(<!-- docs:${name}\\b[^>]*-->\\n)[\\s\\S]*?([ \\t]*<!-- /docs:${name} -->)`)
	if (!between.test(page)) fail('site/docs.html', `the <!-- docs:${name} --> and <!-- /docs:${name} --> comments are missing`)
	return page.replace(between, (_, open, close) => open + body + close)
}

try {
	const old = readFileSync(PAGE, 'utf8')
	// The page keeps the line endings it has, so a checkout on Windows doesn't change every line.
	const eol = old.includes('\r\n') ? '\r\n' : '\n'
	const { toc, article } = build()
	const page = fill(fill(old.replace(/\r\n/g, '\n'), 'toc', toc), 'article', article).replace(/\n/g, eol)
	if (page === old) console.log('site/docs.html is up to date.')
	else if (process.argv.includes('--check')) {
		console.error('site/docs.html is not what the pages in docs/ make. Run `npm run docs` in worker and commit the result.')
		process.exit(1)
	} else {
		writeFileSync(PAGE, page)
		console.log('Wrote site/docs.html.')
	}
} catch (e) {
	if (!(e instanceof DocsError)) throw e
	console.error(e.message)
	process.exit(1)
}
