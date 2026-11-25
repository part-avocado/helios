# Codex

teardrop reads rollouts from `$CODEX_HOME` or `~/.codex`, in both `sessions` and `archived_sessions`, including compressed `.jsonl.zst` files. It handles both the older and the current (0.147 and later) log formats. Subagent and reviewer sessions never count as your prompts.

`teardrop setup` also adds hooks to `~/.codex/hooks.json`, so each prompt and turn end reaches your site as it happens, and a `notify` line to `~/.codex/config.toml`, which syncs when a turn ends. Codex skips new hooks until you trust them: open Codex, run `/hooks`, and trust teardrop's. The `notify` line needs no trust step, so Codex syncs on its own either way. If your `config.toml` already has a `notify` program, teardrop leaves it alone.
