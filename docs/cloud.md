# Remote sessions

Some agents work on a machine that goes away: Claude Code on the web, Codex cloud tasks, a Codespace, or OpenCode or Antigravity on a remote VM. There helios runs in cloud mode.

## Cloud mode in short

- Each hook event goes straight to your site.
- Every cloud machine counts as one computer, called "cloud".
- It is on when `HELIOS_SERVER` and `HELIOS_KEY` are set, together with one of `HELIOS_CLOUD=1`, `CLAUDE_CODE_REMOTE=true` (Claude Code on the web sets it), or `CODESPACES=true`.

[Claude Code in the cloud](claude-code.md#claude-code-in-the-cloud-codespaces-and-remote-machines) describes it in full.

## Commit hooks that install helios

A cloud machine starts from your repository and has no helios of its own. So commit hooks that install it:

```sh
helios setup -project            # Claude Code, Codex, Antigravity, and OpenCode
helios setup codex -project      # or only the tools you name
```

| File | For |
| --- | --- |
| `.claude/settings.json` | Claude Code on the web |
| `.codex/hooks.json` | Codex cloud |
| `.agents/hooks.json` | Antigravity on a remote machine |
| `.opencode/plugins/helios-project.ts` | OpenCode on a server |

Your own settings in those files are kept.

How the committed hooks behave:

- **Without `HELIOS_KEY`, they do nothing.** So nothing changes for a teammate who doesn't use helios.
- **At a session's start, they install helios if it is missing.** They use the installer, which checks the release's checksums.
- **On your own computers, they don't record twice.** The Codex, Antigravity, and OpenCode hooks record only in cloud mode; on your own computers, the hooks `helios setup` adds there record the session. Claude Code's stand down where your own settings already run helios's hook.

## Set up an environment

1. Run `helios setup -project` in the repository, then commit and push.
2. Under Settings, Setup, Sync keys, on your site, make a sync key named after the environment. Copy it when it shows: the site shows it once.
3. In the environment's settings, set `HELIOS_SERVER` to your site and `HELIOS_KEY` to that key. Outside Claude Code on the web and Codespaces, also set `HELIOS_CLOUD=1`.
4. Let the environment reach your site, and `github.com`, `raw.githubusercontent.com`, and `objects.githubusercontent.com`, which it needs to install helios. For Claude Code on the web, use Limited network access and add your site under Allowed domains.

> [!WARNING]
> Anyone who can use the environment can read its variables. A sync key can only upload stats, and you can revoke it under Settings, Setup at any time.

## Notes for each tool

| Where | What to know |
| --- | --- |
| Claude Code on the web | Runs a repository's hooks in a session with one repository. |
| Codex cloud | Codex runs a repository's hooks once they are trusted. Check your dashboard after the first task, since a cloud task may not run them. |
| OpenCode on a server | The plugin runs in the `opencode serve` process. Set the variables where it starts. |
| Antigravity, remote | The workspace's `.agents/hooks.json` runs on the machine the agent works on. |
| Amp's cloud | Has its own plugin: see [Amp cloud threads](amp.md#amp-cloud). |

## A remote machine you keep

A remote machine you keep can instead run the installer and `helios login`, like any computer.

## Remove the hooks

`helios setup -project -remove-hooks` takes the hooks out again.
