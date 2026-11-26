# Codex

helios reads rollouts from `$CODEX_HOME` or `~/.codex`, in both `sessions` and `archived_sessions`, including compressed `.jsonl.zst` files. It handles both the older and the current (0.147 and later) log formats. Subagent and reviewer sessions never count as your prompts.

`helios setup` also adds hooks to `~/.codex/hooks.json`, so each prompt and turn end reaches your site as it happens, and a `notify` line to `~/.codex/config.toml`, which syncs when a turn ends. Codex skips new hooks until you trust them: open Codex, run `/hooks`, and trust helios's. The `notify` line needs no trust step, so Codex syncs on its own either way. If your `config.toml` already has a `notify` program, helios leaves it alone.

## Remote machines and the cloud

On an SSH box, Codespace, or cloud container, set helios up as for [Claude Code](claude-code.md#claude-code-in-the-cloud-codespaces-and-remote-machines). Two things differ for Codex. Its hooks still need the trust step, which a setup script can't do: run `/hooks` once in each new container, or they are skipped. And until then only `notify` runs, which reports turn ends and no prompts, so in cloud mode, where there is no sync to read the rollouts later, a container whose hooks were never trusted earns no time.
