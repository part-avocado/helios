# Claude Code

teardrop reads transcripts from `$CLAUDE_CONFIG_DIR` (which may list several folders), `~/.claude`, and `~/.config/claude`. It tells your prompts apart from tool results, compaction summaries, background notices, and subagent messages.

With hooks installed, Claude Code runs `teardrop hook claude-code` when a session starts or ends, when you send a prompt, and when Claude finishes. Each run appends one line to a local journal: the time, session, folder, and the prompt's word counts and fingerprint, never its text. If Claude Code deletes a transcript, the journal still has that session.
