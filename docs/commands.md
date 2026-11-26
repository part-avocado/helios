# Commands and flags

| Command | What it does |
| --- | --- |
| `teardrop` | Print your timeline and project totals. |
| `teardrop setup` | Check tools, keep history, install hooks and the Amp and OpenCode plugins. |
| `teardrop setup amp` | The same for the tools you name: `claude`, `codex`, `amp`, `opencode`, `copilot`, or `cursor`. |
| `teardrop setup claude -project` | Put hooks in this repository's `.claude/settings.json`, to commit, for [cloud sessions](claude-code.md#or-commit-the-hooks-to-the-repository). |
| `teardrop status` | Show the account this computer syncs to, whether each tool's hooks are installed, what is waiting to send, and when it last synced. |
| `teardrop doctor` | Check everything that decides whether your time counts (this binary, the site and key, the clock, each tool's hooks, records waiting to send, the last background error, and updates) and say how to fix each problem. Exits 1 when something needs fixing. It never prints your key. |
| `teardrop update` | Download the latest teardrop, check it against the release's checksums, replace this one with it, and run setup again. `-check` only says whether a newer version is out; `teardrop update v0.5.0` installs that version, even if it is older. `-auto on` or `-auto off` turns installing new releases by itself on or off. |
| `teardrop dashboard` | Open the live dashboard on localhost. |
| `teardrop hook -check <tool>` | Print the record a hook payload on stdin would make, and write nothing. |
| `teardrop export` | Write a signed report to upload under Settings on the website (`-o file`, `-since`, default 365d). |
| `teardrop login` | Connect this computer by typing a code on the site instead of copying the key (`-server URL` once; `-no-open` prints the address instead of opening a browser). |
| `teardrop sync` | Send your records to your account (`-server URL -key KEY` once; both are remembered). `-dry-run` prints the records it would send, and sends nothing. |
| `teardrop uninstall` | Remove teardrop's hooks, Amp and OpenCode plugins, and PATH line, ask about the journal folder, and delete the binary (`-yes`, `-keep-data`). See [Uninstall](uninstall.md). |
| `teardrop -version` | Print the installed version. |

| Flag | Default | Meaning |
| --- | --- | --- |
| `-since` | `7d` | How far back to count, such as `24h` or `30d`. |
| `-json` | | Print the report as JSON. |
| `-l`, `--live` | | Keep the timeline on screen, updating it as you work. |
| `-every` | `3s` | With `-live`, how often to reread the logs. |
| `-verbose` | | List log files that couldn't be read. |
| `-claude-dir`, `-codex-dir` | | Look for logs in these folders instead (comma-separated). |

`teardrop setup` takes `-yes` and `-remove-hooks`, before or after a tool's name. `teardrop dashboard` takes `-addr` (default `127.0.0.1:7878`) and `-no-open`.
