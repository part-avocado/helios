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
checksum, puts it on your PATH, and runs `teardrop setup`. Run it again to
update. No admin rights are needed. It installs to `~/.local/bin`, or
`%LOCALAPPDATA%\Programs\teardrop` on Windows.

`setup` lists the tools it found and offers to stop Claude Code from deleting
transcripts after 30 days. It changes nothing without asking and is safe to rerun.

With Go 1.25 or later you can also run
`go install github.com/part-avocado/teardrop/cmd/teardrop@latest`.

### Website

`site/` is the website: a landing page, docs, and the dashboard. Pushing a
change to it on `main` publishes it to GitHub Pages with
`.github/workflows/pages.yml`. The same files are built into the binary, so
`teardrop dashboard` serves them with live data from `/api/report`.

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
teardrop export -o stats.json   # signed report for the website's dashboard
```

Exports carry a verification key: an Ed25519 signature by this install's
account key over the numbers, the export time, and a 7-day expiry. The
dashboard refuses files that were edited, have no key, or have expired. The
account key lives on your machine, so this stops editing a file, not someone
who extracts the key; that needs the planned server.

**ENGAGED** counts only time you were plausibly involved: writing prompts and
reading replies (up to 5 minutes before each prompt) and watching the agent
(up to 10 minutes after each prompt). An agent left running alone earns
nothing. Prompts made mostly of unrecognized words, checked against an English
dictionary, code-like words, and words from your own repository, earn no time.
So do repeats (a prompt nearly the same as two of the session's last five)
and autopilot (the third or later "continue", "yes", or "fix it" in a row).
These are listed as **SKIPPED**. Repeats are found with a 64-bit fingerprint
of each prompt; prompt text is never stored.

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
`setup` offers to write a plugin to `~/.config/amp/plugins/teardrop.ts`. It
calls `teardrop hook amp` when a thread starts, when you send a prompt, and
when Amp finishes, and records the same kind of line in the same journal.
Threads that run in Amp's cloud orbs are not on your machine, so they are
not tracked.

Run `teardrop setup -remove-hooks` before uninstalling to remove both.

## Lines of code

For each project the report also shows the lines agents changed (**AGENT
LINES**, from Claude Code's Edit, MultiEdit, and Write calls and Codex's
`apply_patch`), how many of the added lines later turned up in your commits
(**KEPT**), and the lines your commits added in the window (**COMMITTED**).
A session that looks busy but leaves nothing in git shows up here. Lines are
matched by a hash; the code itself is not kept.

## Central server

`teardrop sync -server https://...` uploads your signed counts: time blocks,
prompt and skipped-prompt counts, tokens, and line counts. Once a server is
set, hooks sync in the background every 15 minutes. It never uploads text.

`teardrop submit <project>` submits a project's hours for review together
with the full chat logs behind them: your prompts, the agent's replies, and
its code changes. It asks first, and `-o file` writes the submission so you
can read it before sending. The server refuses a submission whose logs were
changed after signing or that claims a block no log backs, and recomputes the
hours from the logs itself.

Anyone can see an account's totals at `/api/v1/accounts/<id>`. Work blocks,
submissions, and chat logs are for admins only.

### Testing time and Lapse

Time spent testing your build outside the agent chat doesn't count in
teardrop. Record it with [Lapse](https://lapse.hackclub.com) instead. Pass
your Lapse sessions with `teardrop submit -lapse <link>,...` and the server
takes off any time Lapse also recorded, since Hackatime already counts it.

### Running a server

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

The server needs to run somewhere always on; GitHub Pages and Actions can't
host it. The repository has a `Dockerfile` and a `fly.toml` for
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
   fly deploy --build-arg VERSION=v0.3.0 --ha=false
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
