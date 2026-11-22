# teardrop

See how much time you actually spend working with AI coding tools, per project.
teardrop reads the logs Claude Code and Codex already write, so there is
nothing to keep running and nothing to configure inside those tools.

## Install

macOS, Linux, or Git Bash on Windows:

```sh
curl -fsSL https://raw.githubusercontent.com/part-avocado/teardrop/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/part-avocado/teardrop/main/install.ps1 | iex
```

The installer downloads the right binary for your computer, checks its
checksum, puts it on your PATH, and runs `teardrop setup`. To update later,
run `teardrop update` (or the installer again): it downloads the latest
release, checks its checksum, replaces the installed teardrop, and runs setup
again. `teardrop update -check` only says whether a newer version is out, and
`teardrop update v0.5.0` installs that version, even if it is older. No admin
rights are needed. It installs to `~/.local/bin`, or
`%LOCALAPPDATA%\Programs\teardrop` on Windows.

`setup` lists the tools it found and offers to stop Claude Code from deleting
transcripts after 30 days. It changes nothing without asking and is safe to rerun.
To set up one tool only, name it: `teardrop setup amp`, `teardrop setup claude`,
or `teardrop setup codex`.

With Go 1.25 or later you can also run
`go install github.com/part-avocado/teardrop/cmd/teardrop@latest`.

### Website

`site/` is the website: a landing page, docs, the dashboard, and settings.
`worker/` serves it on Cloudflare Workers and adds accounts: people sign in
with Hack Club Auth, their synced stats are kept in a D1 database, and every
report their computers send is kept in an R2 bucket for reviewers. See
[The website, on Cloudflare](#the-website-on-cloudflare).

The same files are built into the binary, so `teardrop dashboard` serves the
dashboard with live data from this machine, with no account.

### Releasing

Pushing a tag such as `v0.1.0` runs `.github/workflows/release.yml`. It
builds every binary with `scripts/build-release.sh` and publishes them, with
`checksums.txt`, as the release the installers download.

## Use

```sh
teardrop               # last 7 days
teardrop -since 30d
teardrop -json         # the same report as data
teardrop -l            # keep it on screen, updating as you work (also --live)
teardrop dashboard     # live charts in your browser, served on localhost only
teardrop export -o stats.json   # signed report to upload on the website, under Settings
```

Syncs and exports carry a verification key: an Ed25519 signature by this
install's account key over the numbers, the time it was made, and a 7-day
expiry. The website refuses reports that were edited, have no key, or have
expired. The account key lives on your machine, so a file alone can't prove its numbers
are real. For hours that count, use `teardrop submit` (below): the site
credits only time whose records reached it as it happened.

**ENGAGED** counts the time you spend working with your AI tools: writing
prompts, reading replies, and steering the agent. An agent left running on
its own doesn't earn time, and parallel sessions on one project count once.
Prompts that don't reflect real work aren't counted; they're listed as
**SKIPPED**. Prompt text is never stored.

## Supported tools

| Tool | Where teardrop looks |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR` (comma-separated), `~/.claude`, `~/.config/claude` |
| Codex CLI and IDE extension | `$CODEX_HOME`, `~/.codex` (`sessions` and `archived_sessions`, including `.jsonl.zst`) |
| Amp CLI and editor extensions | the journal, written by the teardrop Amp plugin (below) |
| Amp cloud threads (the Amp app, ampcode.com) | your teardrop site, sent by the teardrop cloud plugin (below) |
| GitHub Copilot CLI and VS Code agent | the journal, written by hooks in `~/.copilot/hooks/teardrop.json` |
| Cursor | the journal, written by hooks in `~/.cursor/hooks.json` |
| Any other harness | the journal, written by `teardrop hook <tool>` (see "Add your own harness" in the docs) |

Override them with `-claude-dir` and `-codex-dir`.

## Hooks and plugins

`teardrop setup` offers to add hooks to Claude Code's `settings.json`. They
run `teardrop hook claude-code` when a session starts or ends, when you send a
prompt, and when Claude finishes. Each run appends one line (time, event,
session, folder, and the prompt's word counts and fingerprint, never its text) to a journal
in `~/.local/share/teardrop`, `~/Library/Application Support/teardrop` on
macOS, or `%LOCALAPPDATA%\teardrop` on Windows. Set `TEARDROP_DATA_DIR` to
change it.

The report uses a session's transcript when it exists and the journal when it
doesn't, so history survives even after Claude Code deletes transcripts. Your
other hooks are kept. Rerunning `setup` after moving teardrop updates the
path.

For Amp, which keeps threads on its servers rather than in local files,
`setup` (or `teardrop setup amp` for Amp alone) offers to write a plugin to `~/.config/amp/plugins/teardrop.ts`. It
calls `teardrop hook amp` when a thread starts, when you send a prompt, and
when Amp finishes, and records the same kind of line in the same journal.
Setup offers the plugin even before Amp is installed, so it is in place when
Amp is.

Threads you start in the Amp app or on ampcode.com run in Amp's cloud, not on
your machine, so that plugin can't see them. A second plugin,
[`amp/teardrop-cloud.ts`](amp/teardrop-cloud.ts), counts them. Your teardrop
site has a prompt for it under Settings, Setup, Amp: paste it into any Amp
thread, and Amp adds the plugin to your personal plugins and sets two values
in its Secrets & Env Vars settings, `TEARDROP_SERVER` (your site) and
`TEARDROP_KEY` (your sync key, which Amp asks you for privately). In a cloud
thread the plugin downloads teardrop, checks its checksum, and runs
`teardrop hook amp -relay`, which sends your site the same line the journal
holds, without the prompt text. The site keeps these lines for a year. No
computer of yours is needed: when Amp finishes a turn or you stop it, the
teardrop in that thread reads all of your cloud lines back, counts them, and
syncs the result as one "Amp cloud threads" entry on your dashboard. Threads
that ran side by side are counted together,
so their overlap counts once. Cloud days are split at midnight UTC.
The Mac app's threads can instead run on your Mac: turn on the runner in the
app's App Settings, Runner, and pick "This Mac" when you start a thread.

Run `teardrop setup -remove-hooks` before uninstalling to remove both, or
`teardrop setup -remove-hooks amp` to remove only the plugin.

## Lines of code

For each project the report also shows the lines agents changed (**AGENT
LINES**, from Claude Code's Edit, MultiEdit, and Write calls and Codex's
`apply_patch`), how many of the added lines later turned up in your commits
(**KEPT**), and the lines your commits added in the window (**COMMITTED**).
A session that looks busy but leaves nothing in git shows up here. Lines are
matched by a hash; the code itself is not kept.

## Accounts, sync, and submit

On the website, sign in with Hack Club and open the dashboard. With nothing
synced yet it shows the two commands that connect a computer; the second is

```sh
teardrop sync -server https://your-site -key tdk_...
```

`sync` uploads your signed counts: time blocks, prompt and skipped-prompt
counts, tokens, and line counts. It never uploads text. teardrop remembers
the server and the key (which can only upload stats), so hooks sync in the
background when a reply finishes in Claude Code or Amp, or when you stop
one. Amp reports a stopped reply at once. Claude Code runs no hook then, so
that sync happens at your next prompt or when the session closes. The
dashboard adds up every computer you
connect. Settings lists them, makes a new key, and takes a
`teardrop export` file from a computer that can't reach the site.

`teardrop submit <project>`, or the review app, submits a project's hours.
Nothing is uploaded: the site makes the submission from the per-prompt
records your hooks already sent it. Only time whose records reached the site
within 5 minutes of when they happened is credited ("witnessed"); time that
arrived late, such as history from before the hooks were set up, is listed
but not credited unless a neoadmin accepts it with a note. Submitting a
project again is fine: time an earlier submission covered is credited once.

Every account has a public profile at `/@handle`, which anyone can open
without signing in: the handle, the month they joined, hours in the past
year, a year of days, and their projects. It never shows a name, a Slack ID,
or a folder: a project is named only when it is a repository on a public host
or its owner chose to show it, and others are only counted. Each account
starts with a neutral handle, such as `u-3f9a0c12b4d1`. Under Settings,
Profile, its owner changes the handle, hides or names projects, or makes the
profile private. `GET /api/public/v1/users/{handle}` returns the same, with
no key.

Everything else on the website is visible to you and to reviewers: a reviewer
sees your total for each project, and neoadmins and superadmins see
everything you synced. Submissions hold no chat logs: they are made from the
per-prompt records the site already has.

### The website, on Cloudflare

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars   # signs you in as DEV_LOGIN, on localhost only
npm run dev
```

To put it online without installing anything, connect this repository in the
Cloudflare dashboard (Workers & Pages, Create, Import a repository). Name the
Worker `teardrop`, set the root directory to `worker`, the build command to
`npm ci`, and the deploy command to `npm run deploy`. The first deploy creates
the D1 database, its tables, and the R2 bucket. R2 has to be turned on for
your Cloudflare account first, which you do once under R2 in the dashboard.

Then create a Hack Club Auth app with the `openid`, `profile`, and `slack_id`
scopes and `https://<your-worker>.workers.dev/auth/callback` as its redirect
URI, and add these as secrets under the Worker's Settings, Variables and
Secrets: `SESSION_SECRET` (any long random text), `HCA_CLIENT_ID`,
`HCA_CLIENT_SECRET`, and `ADMINS` (Slack user IDs, comma-separated). Until
they are set, the site says it is not set up yet. To deploy from your own
computer instead, run `npx wrangler login`, then `npm run deploy`, in `worker/`.

#### The review app

Reviewing has its own app at `/review/`, apart from the rest of the site,
with its own API under `/api/review/`. Reviewers get a Review link in the top
bar. There are three levels:

| Level | Who | What they can do |
| --- | --- | --- |
| 0, superadmin | the Slack IDs in `ADMINS` | Everything below, and add or remove neoadmins. |
| 1, neoadmin | added by a superadmin | Read every account: computers, projects, and the log of every report, each kept as it arrived in the R2 bucket. Add and remove reviewers. Ban people. |
| 2, reviewer | added by a neoadmin or superadmin | Look a person up by Slack ID and read their total for each project, with each project's graphs. Nothing else of theirs. |

Levels and bans are set on a person's account view: look them up by Slack ID
and use its Access and Bans panels. A Slack ID that has never signed in opens
a view with only those two, so people can be added or banned before they first
sign in. The Reviewers and Bans pages list who holds each level and every ban,
each linking to that account view. No one can add, remove, or ban someone at
their own level or above, so a neoadmin can't touch another neoadmin.

Each person's page has a Project activity panel. For one project at a time it
draws engaged time and lines added and removed per day, when in the week they
work, and every work block's length against the share of it that was engaged.
It also checks the blocks for what a reviewer should ask about: time counted
on two computers at once, long blocks without breaks, lines changed without a
prompt, very many lines per hour, and days over 14 hours. The graphs come from
the work blocks in each computer's latest report.

A ban has no length: it lasts until someone lifts it, and always has a
reason, which only reviewers see. While it holds, the site takes nothing new
from the person (syncs, uploads, cloud events, submissions). `teardrop sync`,
their dashboard, and their settings say plainly that they are banned until a
reviewer lifts it, but not why. They can still sign in and see what they had. The review
app marks a banned person in red wherever they appear. A banned reviewer can't
review. Someone below the level of whoever issued a ban can't lift or replace
it.

Any reviewer can make API keys on the app's API keys page. A key acts as the
person who made it, at whatever level they hold when it is used, and stops
working when they are removed or banned. It is shown once; the site keeps
only its hash.

```sh
curl -H "Authorization: Bearer tdr_..." "https://<your-site>/api/review/person?slack=U012ABCDEF"
```

The log stays when a person deletes their account; the reports kept in full go.
Set a `GITHUB_TOKEN` secret to have the hourly cron check claimed commits
against GitHub. `npm test` runs the Worker's tests in the Workers runtime.

#### Public API

Anyone with an account can make read keys (`tdp_...`) under Settings, API,
and read their own stats with them from a script or another site, for example
to list their projects when they sign in there. A read key can only read, a
banned person's keys read nothing, and the site keeps only each key's hash.
Answers allow any origin, since the API takes no cookies.

| Call | Returns |
| --- | --- |
| `GET /api/public/v1/me` | name, Slack ID, when they joined, engaged seconds in the past year, last sync |
| `GET /api/public/v1/projects` | each project's name, repository (or `null` for a folder, which stays private), engaged seconds, and first and last activity |
| `GET /api/public/v1/days?since=YYYY-MM-DD` | engaged seconds per day |

Sites can also get a key with **Sign in with teardrop**: send the person to
`/authorize?redirect_uri=…&state=…&name=…`, they choose Allow, and they come
back with a `code` that `POST /api/public/v1/token` (with the same
`redirect_uri`, and `code_verifier` if you sent a PKCE `code_challenge`)
trades once for a `tdp_` key. Codes last 5 minutes, `redirect_uri` must be
https (or localhost), and a code traded twice revokes its key. See the docs
for details.

Migration 0008 adds the table of read keys, 0009 keeps each computer's work
blocks for the review graphs, 0010 adds sign-in codes, 0011 adds profile
handles and the choice of which projects a profile names, and 0012 makes
every ban last until lifted: timed bans that had run out are marked lifted,
and ones still in force become permanent, keeping their old end in
`was_until`.

### Moving from the old review server

The Go review server that took chat-log submissions is retired. Run
`teardrop export-records -data <its data folder> > records.jsonl` and post the
file to `/api/review/import` as a superadmin, so what it credited is never
credited again.

### Hosting cost

`node worker/scripts/cost-model.ts [prompts per hour]` prints the monthly bill
from named inputs. At 15,488 people and 109,759 engaged hours a month it is
about $13 after a year at 20 prompts an hour, and $40 at 60, against a $500
limit. `account_log` (one row per sync) is what grows D1 toward its 10 GB
limit, in the second year at that load.

## Privacy

teardrop reads timestamps, token counts, line counts, and working
directories. Prompt text is scored in memory and dropped; it is never stored
or printed, and `sync` never uploads it. In Amp's cloud, the cloud plugin
sends your site each prompt's time, thread, folder, repository, and word
counts, without its text. Every harness's hooks send the same kind of record
for each prompt and turn end, which the site keeps in R2 for good. Chat logs
and prompt text never leave your machine.

## License

teardrop is licensed under the GNU Affero General Public License v3.0. See
[LICENSE](LICENSE). The bundled English word list is from SCOWL; see
[internal/textscore/WORDS-LICENSE](internal/textscore/WORDS-LICENSE).
