# Claude Code

teardrop reads transcripts from `$CLAUDE_CONFIG_DIR` (which may list several folders), `~/.claude`, and `~/.config/claude`. It tells your prompts apart from tool results, compaction summaries, background notices, and subagent activity. Subagent transcripts are ignored: their time, tokens, and edits do not count.

With hooks installed, Claude Code runs `teardrop hook claude-code` when a session starts or ends, when you send a prompt, and when Claude finishes. Each run appends one line to a local journal: the time, session, folder, and the prompt's word counts and fingerprint, never its text. If Claude Code deletes a transcript, the journal still has that session.

<a id="claude-code-in-the-cloud-codespaces-and-remote-machines"></a>
## Claude Code in the cloud, Codespaces, and remote machines

Which setup fits depends on whether the machine lasts.

### A machine you keep, such as an SSH box

Install teardrop there and connect it like any computer. With no browser on it, run `teardrop login -server https://your-site -no-open`, which prints a code to type on the site from any other device. Or make a sync key under Settings on the site and run `teardrop sync -server https://your-site -key tdk_…`. The box keeps its own journal, is listed as a computer of its own, and syncs in the background.

Setting `TEARDROP_SERVER` and `TEARDROP_KEY` in the box's environment works too, with no login: hooks then send each event as it happens and sync in the background, just as after a login.

### A machine that goes away: cloud sessions, Codespaces, dev containers

Transcripts and the journal in a cloud container disappear with it, so there teardrop sends each hook event straight to your site instead of keeping a journal. This is cloud mode. It is on when `TEARDROP_SERVER` and `TEARDROP_KEY` are both set and one of `CLAUDE_CODE_REMOTE`, `CODESPACES`, or `TEARDROP_CLOUD` is `1` or `true`. Claude Code on the web sets the first and GitHub Codespaces the second by themselves.

1. On the site, make a key under Settings.
2. Add two secrets to the environment: `TEARDROP_SERVER` (your site) and `TEARDROP_KEY` (the key). For Codespaces, add them as Codespaces secrets of your account or the repository. Also set `TEARDROP_CLOUD=1` unless the environment sets `CLAUDE_CODE_REMOTE` or `CODESPACES` itself.
3. Add this to the environment's setup script, or for a Codespace or dev container, to `postCreateCommand` in `devcontainer.json`:

```sh
curl -fsSL https://raw.githubusercontent.com/part-avocado/teardrop/main/install.sh | TEARDROP_CLOUD=1 sh
```

It installs teardrop, creates `~/.claude` if no Claude Code folder exists, and adds the hooks of every tool it finds without asking. `teardrop doctor` says whether cloud mode is on, and which secret is missing when it is not.

<a id="or-commit-the-hooks-to-the-repository"></a>
### Or commit the hooks to the repository

If you can't edit the environment's setup script, run this once in the repository, on your own computer, and commit the file it writes:

```sh
teardrop setup claude -project
```

It adds hooks to the repository's `.claude/settings.json`, keeping whatever is there. In a session where `TEARDROP_KEY` is set, the session's start installs teardrop if it is missing, and each prompt and reply runs `teardrop hook claude-code -project`, found on `PATH` or in `~/.local/bin`. Where `TEARDROP_KEY` is not set, they do nothing: nothing is installed or recorded for teammates who don't use teardrop. They also do nothing where your own Claude Code settings already have teardrop's hooks, as on your own computer or a machine the setup script set up, so each event is recorded once. You still add the two secrets to the environment. If the repository's hooks don't end in `-project`, an older teardrop added them: run `teardrop setup claude -project` again and commit the change, since those don't check for your own hooks. `teardrop setup claude -project -remove-hooks` takes them out again.

### What cloud mode sends

Each event goes to your site as it happens, with what a journal line holds: the time, tool, session, and a prompt's word counts and fingerprint, never its text. Because the site can't look the folder up later, the event also carries the repository, named from its `origin` remote without any sign-in the remote holds, and the folder's path inside the container, such as `/home/user/repo`. A reply's end carries the tokens and lines of that turn, read from the transcript, and your commits in the repository since the last one. No sync runs there, and no account key is made.

Cloud sessions all count as one computer, called "cloud", however many containers ran them, so a new container never adds a computer to your list. That computer has no clock correction and no time zone of its own: its records are used at the times the container gave them, and its days are counted at the UTC offset your own computers pinned for your account. Subagent activity is not counted there either.
