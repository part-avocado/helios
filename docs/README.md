# helios docs

Everything you need to install helios, read your stats, and sync them to your site.

## Getting started

- [Quick start](quick-start.md)
- [Install](install.md)
- [helios setup](setup.md)

## Using helios

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
- [Antigravity](antigravity.md)
- [Remote sessions](cloud.md)
- [Connectors for Claude and other chat apps](connectors.md)
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

Each file here is one section of the docs page on the site. This file lists
them in the order, and under the groups, that the page's contents show.

After changing any page:

1. Run `npm run docs` in `worker`. It needs only Node.js, no `npm install`.
2. Commit `site/docs.html` with your change. That page is built from these
   files, and the tests fail when it is out of date.

To add a page, add a file and a line for it above.

### Markdown you can use

The script that builds the page, `worker/scripts/docs.ts`, reads only the
Markdown below. At anything else it stops and names the file and line.

- A page starts with its title, a `#` heading. `##` and `###` headings go under it.
- Paragraphs, `-` and `1.` lists (not one inside another), tables, and code between lines of three backticks.
- `code`, `**bold**`, `*emphasis*`, and `[links](install.md)`. Write `\` before a `*`, `[`, `<`, or backtick that is only itself, and `\|` for a `|` in a table.
- `> [!NOTE]`, `> [!IMPORTANT]`, and `> [!WARNING]` boxes.

### Links

- To another page here, link to its file: `[Install](install.md)`.
- To a heading, link to its name: `[flags](sync.md#server)`.
- To a page of the site, link to its file in `site`: `[Settings](../site/settings.html)`.

A heading has a name only if the line before it gives it one, as
`<a id="stats-api"></a>` does. A page's title is otherwise named after its
file. Other pages and other sites link to these names, so keep the ones
there are.
