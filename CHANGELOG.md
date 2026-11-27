# Changelog

## v1.0.1

### Fixed

- **Installing.** The install commands failed with a 404, because v1.0.0's
  downloads still carried the old `teardrop_*` names. This release's
  downloads are named `helios_*`, as `install.sh`, `install.ps1`, and
  `helios update` expect. Anyone with the old `teardrop` binary should run
  the install command again rather than `teardrop update`.

### Changed

- **The website** is dark unless you pick light with the switch, has a new
  sun logo, shows the whole install command on a desktop, and names you by
  your @handle in the account menu.

## v1.0.0

helios now counts time in every place you work with an agent: on your
computer, on a machine that goes away, and in chat apps.

### Where it works

| Tool | On your computer | In the cloud |
| --- | --- | --- |
| Amp | plugin (`helios setup amp`) | Amp cloud threads, through `amp/helios-cloud.ts` |
| Claude Code | transcripts and hooks | Claude Code on the web and Codespaces, in cloud mode (`helios setup claude -project`) |
| Codex | transcripts, hooks, and `notify` | Codex cloud, in cloud mode (`helios setup codex -project`; check the first task) |
| Antigravity | **new:** hooks in `~/.gemini/config/hooks.json` | **new:** `.agents/hooks.json` (`helios setup antigravity -project`) |
| OpenCode | plugin | **new:** `opencode serve` on a VM (`helios setup opencode -project`) |
| Claude on the web, ChatGPT, other chat apps | | **new:** the site's connector, at `/mcp` |

### New

- **Antigravity.** `helios setup antigravity` adds hooks for the App, the
  CLI, and the IDE: a session's start, each prompt (an execution's first
  model call), and each turn's end. `helios uninstall` removes them.
- **Cloud mode.** With `HELIOS_SERVER` and `HELIOS_KEY` in the
  environment, on a machine marked by `HELIOS_CLOUD=1`,
  `CLAUDE_CODE_REMOTE=true`, or `CODESPACES=true`, hooks send each event
  straight to the site as one "cloud" computer, with each Claude Code turn's
  tokens read from its transcript. `install.sh` and `install.ps1` take
  `HELIOS_CLOUD=1`, and `doctor` and `login` understand cloud mode.
- **Repository hooks for every cloud tool.** `helios setup -project` writes
  committable hooks for Claude Code, Codex, Antigravity, and OpenCode, or for
  the tools you name. They do nothing without `HELIOS_KEY`, install
  helios at a session's start, and record only where they should: Codex's,
  Antigravity's, and OpenCode's in cloud mode only, and Claude Code's only
  where your own settings don't already run helios.
- **Connectors.** Your site is a remote MCP server at `/mcp`, with OAuth
  (dynamic client registration and PKCE). Add it to Claude on the web, the
  Claude apps, ChatGPT, or any MCP app. `helios_log` records the start and
  end of each reply, timed by the site's clock, so the time is witnessed.
  `helios_stats` answers questions about your hours. Each app gets a sync
  key named after it, which you revoke under Settings to disconnect it.
  Records name the app, such as `claude-ai`, so reviewers can tell chat time
  from coding.

### Changed

- Credited time is harder to inflate. Subagent transcripts are ignored, and
  composing time is earned only by reading agent output. Overlapping project
  time is split, and a day is credited at most 16 hours. Time sent under
  several computer IDs counts once.
- The OpenCode plugin runs its hook in the session's folder.
- Release notes come from this file.

### Upgrading

Run `helios update`. Then rerun `helios setup` to add Antigravity's hooks,
and `helios setup -project` in repositories you work on in the cloud. Deploy
the Worker for connectors: an older site has no `/mcp`.
