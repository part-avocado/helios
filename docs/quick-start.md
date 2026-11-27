# Quick start

## 1. Install helios

On macOS, Linux, or Git Bash on Windows:

```
curl -fsSL https://raw.githubusercontent.com/part-avocado/helios/main/install.sh | sh
```

On Windows, in PowerShell:

```
irm https://raw.githubusercontent.com/part-avocado/helios/main/install.ps1 | iex
```

## 2. Answer the setup questions

The installer finishes by running `helios setup`. It lists the tools it found and asks before each change:

- Keep Claude Code transcripts past 30 days.
- Add helios's hooks or plugin to Claude Code, Codex, Amp, OpenCode, Copilot, and Cursor.

Saying yes to each is the recommended setup. [helios setup](setup.md) explains every question.

Then use your tools as you normally do.

## 3. See your time

### Just this computer

Run `helios` for your timeline and project totals, or `helios dashboard` for charts in your browser. You need no account, and nothing leaves your computer.

### On the website

To see every computer's hours in one place:

1. Open the [dashboard](../site/dashboard.html) and choose **Sign in with Hack Club**. Your first sign-in creates your account.
2. Choose **Start setup**, then **Do it yourself**, and run the command it shows. It is the install command again, which is harmless, followed by `helios login`.
3. Your terminal prints a code. Type it on the setup's last step, check that the computer ID matches the one in your terminal, and choose **Connect**. The dashboard fills in by itself.
4. Do the same on each computer you code on, from Settings, Setup, **Add a computer**. Each one syncs by itself from then on.

Only use Amp in its app or on ampcode.com? You need no computer at all: see [Amp cloud threads](amp.md#amp-cloud).
