# teardrop docs

Everything you need to install teardrop, read your stats, and sync them to your site.

## Getting started

- [Quick start](quick-start.md)
- [Install](install.md)
- [teardrop setup](setup.md)

## Using teardrop

- [The report](report.md)
- [The dashboard](dashboard.md)
- [Your account](dashboard.md#account)
- [Public profile](dashboard.md#profile)
- [Verification keys](dashboard.md#verification-keys)
- [Tokens](tokens.md)

## Editors & agents

- [Claude Code](claude-code.md)
- [Codex](codex.md)
- [Amp](amp.md)
- [Amp cloud threads](amp.md#amp-cloud)
- [Copilot and Cursor](copilot-cursor.md)
- [OpenCode](opencode.md)
- [Add your own harness](own-harness.md)
- [Lines of code](lines.md)

## Reference

- [Commands and flags](commands.md)
- [Files and folders](files.md)
- [Sync](sync.md)
- [Running a server](run-server.md)
- [Deploy to Cloudflare](run-server.md#cloudflare)
- [The review app](run-server.md#review-app)
- [Stats API](run-server.md#stats-api)
- [Public API](run-server.md#public-api)
- [Privacy](privacy.md)
- [Troubleshooting](troubleshooting.md)
- [Uninstall](uninstall.md)

## Editing these pages

Each file here is one section of the docs page on the site, and this file
lists them in the order and groups its contents show. After changing any of
them, run `npm run docs` in `worker` (it needs only Node.js, no `npm install`)
and commit `site/docs.html` with your change: that page is built from these
files, and the tests fail when it is out of date. To add a page, add a file
and a line for it above.

The script that builds the page, `worker/scripts/docs.ts`, reads this much
Markdown, and stops with the file and line of anything else:

- A page starts with its title, a `#` heading. `##` and `###` headings go under it.
- Paragraphs, `-` and `1.` lists (not one inside another), tables, and code between lines of three backticks.
- `code`, `**bold**`, `*emphasis*`, and `[links](install.md)`. Write `\` before a `*`, `[`, `<`, or backtick that is only itself, and `\|` for a `|` in a table.
- `> [!NOTE]`, `> [!IMPORTANT]`, and `> [!WARNING]` boxes.

Link to another page here by its file, as `[Install](install.md)`, and to a
heading by its name, as `[flags](sync.md#server)`. A heading has a name only
if the line before it gives it one, as `<a id="stats-api"></a>` does; a
page's title is otherwise named after its file. Other pages and other sites
link to these names, so keep the ones there are. Link to a page of the site
by its file in `site`, as `[Settings](../site/settings.html)`.
