# OpenCode

`helios setup` (or `helios setup opencode`) writes a plugin to `~/.config/opencode/plugins/helios.ts`. When `$OPENCODE_CONFIG_DIR` is set, it goes in that folder's `plugins` folder instead. OpenCode 1 and 2 both load it.

The plugin runs `helios hook opencode` when you send a prompt and when a turn ends, whether it finished, failed, or was stopped. It records the time and folder, never the prompt text.

Two limits:

- Prompts in a subagent's session come from the agent, so they aren't counted as yours.
- OpenCode keeps its history in a database helios doesn't read, so time before the plugin was added doesn't count.
