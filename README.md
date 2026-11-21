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
are real. For hours that count, use `teardrop submit` (below): the server
checks the hours against the chat logs behind them.

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
Amp is. Threads that run in Amp's cloud orbs are not on your machine, so they
are not tracked. That includes threads started in the Amp Mac app, unless they
run on your Mac: turn on the runner in the app's App Settings, Runner, and
pick "This Mac" when you start a thread.

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
background every 15 minutes. The dashboard adds up every computer you
connect. Settings lists them, makes a new key, and takes a
`teardrop export` file from a computer that can't reach the site.

`teardrop submit <project>` submits a project's hours for review together
with the full chat logs behind them: your prompts, the agent's replies, and
its code changes. It asks first, and `-o file` writes the submission so you
can read it before sending. The server refuses a submission whose logs were
changed after signing or that claims a block no log backs, and recomputes the
hours from the logs itself. Submitting a project again is fine: time that an
earlier submission of it already covered is credited once.

Your stats on the website are visible to you and to admins. Submissions and
chat logs are for admins only.

### Testing time and Lapse

Time spent testing your build outside the agent chat doesn't count in
teardrop. Record it with [Lapse](https://lapse.hackclub.com) instead. Pass
your Lapse sessions with `teardrop submit -lapse <link>,...` and the server
takes off any time Lapse also recorded, since Hackatime already counts it.

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

Admins get a Review page, linked from the top bar and the account menu, that
lists everyone. From it they look a person up
by Slack ID to see their dashboard, their computers, and a log of every
report they sent. Each entry opens to show what the report held and which
days and projects changed, and links to the report itself: every report is
kept as it arrived, in an R2 bucket. The page also has each computer's
history and the whole log as a JSON download. The log stays when a person
deletes their account; the reports kept in full go.
Set `REVIEW_SERVER` in `wrangler.jsonc` to the address of the review server
below and `teardrop submit` goes through the website, which then asks for a
sync key. `npm test` runs the Worker's tests in the Workers runtime.

### The review server

The review server takes `teardrop submit`, recomputes the hours from the
chat logs, and serves the review pages. It keeps its data in files, so it
needs a machine that stays on.

```sh
TEARDROP_ADMINS=U012ABCDEF,U034GHIJKL \
TEARDROP_HCA_CLIENT_ID=... TEARDROP_HCA_CLIENT_SECRET=... \
teardrop server -addr :8080 -data /var/lib/teardrop -public-url https://teardrop.example.org
```

Admins sign in with [Hack Club Auth](https://auth.hackclub.com) at `/admin`
and see every account, submission, and chat. `TEARDROP_ADMINS` lists their
Slack user IDs (in Slack: profile, ⋮, Copy member ID); Hack Club Auth tells
the server the Slack ID linked to whoever signs in.

To set up sign-in, open Developer Apps on
[auth.hackclub.com](https://auth.hackclub.com), create an app with the
`openid` and `slack_id` scopes, and add `<public-url>/auth/callback` as its
redirect URI. Put the app's client ID and secret in
`TEARDROP_HCA_CLIENT_ID` and `TEARDROP_HCA_CLIENT_SECRET`. `-public-url` can
also come from `TEARDROP_PUBLIC_URL`. To try the review pages locally without
Hack Club Auth, run `teardrop server -addr 127.0.0.1:8080 -dev-login U012ABCDEF`.

The review page shows the claimed hours, the hours the server recomputed
from the logs, and every chat with the time between messages. Reviewers add
a project's Lapse or Lookout sessions there, and the time they overlap is
deflated automatically.

### Deploy to Fly.io

The server needs to run somewhere always on; Cloudflare Workers and GitHub
Actions can't host it. The repository has a `Dockerfile` and a `fly.toml` for
[Fly.io](https://fly.io). With [flyctl](https://fly.io/docs/flyctl/install/)
installed and signed in, from a clone of this repository:

1. Pick an app name and put it in `fly.toml` (`app`, and the host in
   `TEARDROP_PUBLIC_URL`), then create the app:

   ```sh
   fly apps create <app>
   ```

2. Create the volume that holds accounts and submissions, in the region from
   `fly.toml`:

   ```sh
   fly volumes create teardrop_data --region iad --size 1
   ```

3. In your Hack Club Auth app, add `https://<app>.fly.dev/auth/callback` as a
   redirect URI. Then set the secrets:

   ```sh
   fly secrets set TEARDROP_ADMINS=U012ABCDEF \
     TEARDROP_HCA_CLIENT_ID=... TEARDROP_HCA_CLIENT_SECRET=...
   ```

4. Deploy:

   ```sh
   fly deploy --build-arg VERSION=v0.5.0 --ha=false
   ```

Run exactly one machine: the server keeps its data in files on the volume
(`--ha=false` stops Fly from starting a second one). It stops when idle and
starts on the next request. Check it with `fly logs`; on start it warns if
admins or sign-in are not set up. Then point people at it:

```sh
teardrop sync -server https://<app>.fly.dev
```

To use your own domain, run `fly certs add <domain>`, add the DNS records it
prints, and change `TEARDROP_PUBLIC_URL` and the redirect URI to match.

## Privacy

teardrop reads timestamps, token counts, line counts, and working
directories. Prompt text is scored in memory and dropped; it is never stored
or printed, and `sync` never uploads it. Your chat logs leave your machine
only when you run `teardrop submit` and confirm.

## License

teardrop is licensed under the GNU Affero General Public License v3.0. See
[LICENSE](LICENSE). The bundled English word list is from SCOWL; see
[internal/textscore/WORDS-LICENSE](internal/textscore/WORDS-LICENSE).
