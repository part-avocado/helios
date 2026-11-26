# Codex

## Logs

helios reads Codex's session logs, called rollouts, from `$CODEX_HOME` or `~/.codex`. It looks in both `sessions` and `archived_sessions`, and reads compressed `.jsonl.zst` files too. It handles both the older and the current (0.147 and later) log formats.

Subagent and reviewer sessions never count as your prompts.

## Hooks and notify

`helios setup` also adds two things to Codex:

- **Hooks**, in `~/.codex/hooks.json`. With them, each prompt and turn end reaches your site as it happens.
- **A `notify` line**, in `~/.codex/config.toml`. It syncs when a turn ends. If your `config.toml` already has a `notify` program, helios leaves it alone.

> [!IMPORTANT]
> Codex skips new hooks until you trust them. Open Codex, run `/hooks`, and trust helios's.

The `notify` line needs no trust step, so Codex syncs on its own either way.

## Remote machines and the cloud

On an SSH box, Codespace, or cloud container, set helios up as for [Claude Code](claude-code.md#claude-code-in-the-cloud-codespaces-and-remote-machines). Two things differ for Codex:

- **The hooks still need the trust step**, which a setup script can't do. Run `/hooks` once in each new container, or they are skipped.
- **Until then, only `notify` runs**, and it reports turn ends, not prompts. In cloud mode there is no sync to read the rollouts later. So a container whose hooks were never trusted earns no time.
