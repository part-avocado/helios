# teardrop setup

`teardrop setup` shows every place teardrop looks for logs, how many sessions it found, and when the newest one is from. Then it offers to:

- **Keep Claude Code history.** Claude Code deletes transcripts after 30 days by default. Setup offers to raise `cleanupPeriodDays` to 3650.
- **Add Claude Code hooks** for real-time capture. See [Claude Code](claude-code.md).
- **Add the Amp plugin.** See [Amp](amp.md).

To set up one tool only, name it: `teardrop setup amp`, `teardrop setup claude`, or `teardrop setup codex`. Setup offers the Amp plugin even on a computer where Amp isn't installed yet, so it is in place when Amp is.

> [!NOTE]
> Setup never changes anything without a yes. It keeps your own hooks and settings, saves a backup the first time it edits a file, and is safe to run again. Pass `-yes` to accept everything without prompts.
