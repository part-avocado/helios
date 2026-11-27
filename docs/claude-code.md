# Claude Code

helios counts Claude Code in two ways: it reads the transcripts Claude Code saves, and, with hooks installed, it records each event as it happens.

## Transcripts

helios reads transcripts from `$CLAUDE_CONFIG_DIR` (which may list several folders), `~/.claude`, and `~/.config/claude`.

It tells your prompts apart from tool results, compaction summaries, background notices, and subagent activity. Subagent transcripts are ignored: their time, tokens, and edits do not count.

## Hooks

With hooks installed, Claude Code runs `helios hook claude-code` when a session starts or ends, when you send a prompt, and when Claude finishes.

Each run adds one line to a local journal. The line holds the time, session, folder, and the prompt's word counts and fingerprint, never its text. If Claude Code deletes a transcript, the journal still has that session.

<a id="claude-code-in-the-cloud-codespaces-and-remote-machines"></a>
## Claude Code in the cloud, Codespaces, and remote machines

Which setup fits depends on whether the machine lasts.

### A machine you keep, such as an SSH box

Install helios there and connect it like any computer. With no browser on it, you have three ways to connect:

- **A code.** Run `helios login -server https://your-site -no-open`. It prints a code to type on the site from any other device.
- **A sync key.** Make one on the site under Settings, Setup, Sync keys, and run `helios sync -server https://your-site -key tdk_…`.
- **Environment variables.** Set `HELIOS_SERVER` and `HELIOS_KEY` in the box's environment. This needs no login. Hooks then send each event as it happens and sync in the background, just as after a login.

The box keeps its own journal, is listed as a computer of its own, and syncs in the background.

### A machine that goes away: cloud sessions, Codespaces, dev containers

Transcripts and the journal in a cloud container disappear with it. So there helios sends each hook event straight to your site instead of keeping a journal. This is called cloud mode.

Cloud mode is on when both of these are true:

- `HELIOS_SERVER` and `HELIOS_KEY` are both set.
- One of `CLAUDE_CODE_REMOTE`, `CODESPACES`, or `HELIOS_CLOUD` is `1` or `true`. Claude Code on the web sets the first by itself, and GitHub Codespaces sets the second.

To set it up:

1. On the site, make a sync key under Settings, Setup, Sync keys. Copy it when it shows: the site shows it once.
2. Add two secrets to the environment: `HELIOS_SERVER` (your site) and `HELIOS_KEY` (the key). For Codespaces, add them as Codespaces secrets of your account or the repository. Also set `HELIOS_CLOUD=1`, unless the environment sets `CLAUDE_CODE_REMOTE` or `CODESPACES` itself.
3. Add this to the environment's setup script. For a Codespace or dev container, add it to `postCreateCommand` in `devcontainer.json`:

```sh
curl -fsSL https://raw.githubusercontent.com/part-avocado/helios/main/install.sh | HELIOS_CLOUD=1 sh
```

That line installs helios, creates `~/.claude` if no Claude Code folder exists, and adds the hooks of every tool it finds, without asking.

To check, run `helios doctor`. It says whether cloud mode is on, and which secret is missing when it is not.

<a id="or-commit-the-hooks-to-the-repository"></a>
### Or commit the hooks to the repository

If you can't edit the environment's setup script, run this once in the repository, on your own computer, and commit the file it writes:

```sh
helios setup claude -project
```

It adds hooks to the repository's `.claude/settings.json`, keeping whatever is there. You still add the two secrets to the environment.

What the committed hooks do depends on where they run:

- **Where `HELIOS_KEY` is set**, the session's start installs helios if it is missing. Each prompt and reply then runs `helios hook claude-code -project`, found on `PATH` or in `~/.local/bin`.
- **Where `HELIOS_KEY` is not set**, they do nothing. Nothing is installed or recorded for teammates who don't use helios.
- **Where your own Claude Code settings already have helios's hooks**, they also do nothing, so each event is recorded once. That is the case on your own computer, or on a machine the setup script set up.

If the repository's hooks don't end in `-project`, an older helios added them, and those don't check for your own hooks. Run `helios setup claude -project` again and commit the change.

To take the hooks out again, run `helios setup claude -project -remove-hooks`.

### What cloud mode sends

Each event goes to your site as it happens. It holds what a journal line holds: the time, tool, session, and a prompt's word counts and fingerprint, never its text.

The site can't look the folder up later, so the event also carries:

- the repository, named from its `origin` remote, without any sign-in the remote holds;
- the folder's path inside the container, such as `/home/user/repo`.

A reply's end also carries the tokens and lines of that turn, read from the transcript, and your commits in the repository since the last one.

No sync runs there, and no account key is made.

### How cloud sessions are counted

- **One computer.** Cloud sessions all count as one computer, called "cloud", however many containers ran them. So a new container never adds a computer to your list.
- **No clock correction.** That computer's records are used at the times the container gave them.
- **No time zone of its own.** Its days are counted at the UTC offset your own computers pinned for your account.
- **No subagents.** Subagent activity is not counted there either.
