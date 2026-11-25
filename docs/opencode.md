# OpenCode

`teardrop setup` (or `teardrop setup opencode`) writes a plugin to `~/.config/opencode/plugins/teardrop.ts`, or the `plugins` folder of `$OPENCODE_CONFIG_DIR` when that is set. OpenCode 1 and 2 both load it. It runs `teardrop hook opencode` when you send a prompt and when a turn ends, finished, failed, or stopped, recording the time and folder, never the prompt text. Prompts in a subagent's session come from the agent, so they aren't counted as yours. OpenCode keeps its history in a database teardrop doesn't read, so time before the plugin was added doesn't count.
