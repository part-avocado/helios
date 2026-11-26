# Tokens

Where token counts come from depends on the tool:

| Tool | Where its counts come from |
| --- | --- |
| Claude Code | The usage record it saves with each response. A response that's written several times, or copied into a resumed session, counts once. |
| Codex | The usage record it saves with each response. Counts are taken from the increase in its running totals. |
| Amp | The usage Amp hands the helios plugin when a turn ends. This starts with helios v0.6.0, so Amp turns recorded before that show no tokens. |
