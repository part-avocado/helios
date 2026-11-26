# Quick start

Install helios. On macOS, Linux, or Git Bash on Windows:

```
curl -fsSL https://raw.githubusercontent.com/part-avocado/helios/main/install.sh | sh
```

On Windows, in PowerShell:

```
irm https://raw.githubusercontent.com/part-avocado/helios/main/install.ps1 | iex
```

The installer then runs `helios setup`, which lists the tools it found and asks before each change: to keep Claude Code transcripts past 30 days, and to add helios's hooks or plugin to Claude Code, Codex, Amp, OpenCode, Copilot, and Cursor. Saying yes to each is the recommended setup; see [helios setup](setup.md). Then use your tools as you normally do.

## Just this computer

Run `helios` for your timeline and project totals, or `helios dashboard` for charts in your browser. You need no account, and nothing leaves your computer.

## On the website

To see every computer's hours in one place:

1. Open the [dashboard](../site/dashboard.html) and sign in with Hack Club. Your first sign-in creates your account.
2. Run the command the dashboard shows, then type the code your terminal prints on the site.
3. Do the same on each computer you code on. Each one syncs by itself from then on.
