# helios setup

`helios setup` first shows every place helios looks for logs, how many sessions it found, and when the newest one is from.

Then it offers each of these changes, one at a time:

- **Keep Claude Code history.** Claude Code deletes transcripts after 30 days by default. Setup offers to raise `cleanupPeriodDays` to 3650.
- **Add Claude Code hooks**, which record your work as it happens. See [Claude Code](claude-code.md).
- **Add Codex hooks.** See [Codex](codex.md).
- **Add the Amp plugin.** See [Amp](amp.md).
- **Add the OpenCode plugin.** See [OpenCode](opencode.md).
- **Add Copilot and Cursor hooks.** See [Copilot and Cursor](copilot-cursor.md).
- **Add Antigravity hooks.** See [Antigravity](antigravity.md).

> [!NOTE]
> Setup never changes anything without a yes. It keeps your own hooks and settings, saves a backup the first time it edits a file, and is safe to run again. Pass `-yes` to accept everything without prompts.

## Set up one tool only

Name the tool: `helios setup claude`, `codex`, `amp`, `opencode`, `antigravity`, `copilot`, or `cursor`. You can name more than one.

Setup offers the Amp plugin even on a computer where Amp isn't installed yet, so the plugin is in place when Amp is.

## Set up cloud sessions

Cloud sessions of a repository, such as Claude Code on the web or Codex cloud, need hooks in the repository itself. Run `helios setup -project` in the repository instead. See [Remote sessions](cloud.md).
