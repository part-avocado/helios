# Files and folders

helios keeps its own files in one folder, the journal folder:

| System | Journal folder |
| --- | --- |
| macOS | `~/Library/Application Support/helios` |
| Windows | `%LOCALAPPDATA%\helios` |
| Anywhere else | `~/.local/share/helios` |

Set `HELIOS_DATA_DIR` to use another folder.

| What | Where |
| --- | --- |
| Hook journal | The journal folder. |
| Server and sync key | `server` and `key` in the journal folder. `HELIOS_SERVER` and `HELIOS_KEY` override them. |
| Account key | `account.key` in the journal folder. Keep it private. Deleting it starts a new account. |
| Project words | `vocab` in the journal folder. It holds the identifiers in each project you worked on in the past week. A background sync saves it once a day, so that hooks count your project's own names as words. They never leave your computer. |
| Claude Code hooks | The `hooks` setting in Claude Code's `settings.json`. |
| Amp plugin | `~/.config/amp/plugins/helios.ts` |
| Settings backups | `settings.json.helios-backup`, next to the original. |
