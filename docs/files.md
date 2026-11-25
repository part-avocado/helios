# Files and folders

| What | Where |
| --- | --- |
| Server and sync key | `server` and `key` in the journal folder below. `TEARDROP_SERVER` and `TEARDROP_KEY` override them. |
| Account key | `account.key` in the journal folder below. Keep it private; deleting it starts a new account. |
| Hook journal | `~/.local/share/teardrop`, `~/Library/Application Support/teardrop` on macOS, `%LOCALAPPDATA%\teardrop` on Windows. Override with `TEARDROP_DATA_DIR`. |
| Claude Code hooks | The `hooks` setting in Claude Code's `settings.json`. |
| Amp plugin | `~/.config/amp/plugins/teardrop.ts` |
| Project words | `vocab` in the journal folder: the identifiers in each project you worked on in the past week, which a background sync saves once a day so that hooks count your project's own names as words. They never leave your computer. |
| Settings backups | `settings.json.teardrop-backup`, next to the original. |
