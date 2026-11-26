# Add your own harness

Any tool can report to helios. Run `helios hook <tool>` with one JSON object on stdin:

```
{"session_id": "abc123", "cwd": "/home/me/project", "hook_event_name": "prompt", "prompt": "add a login page"}
```

The tool name is yours to choose, from lowercase letters, digits, and dashes.

| Field | Meaning |
| --- | --- |
| `session_id` | Required. One conversation or thread. |
| `hook_event_name` | Required, unless you pass `-event` instead. One of `prompt`, `turn_end`, `session_start`, `session_end`, or `edit`. |
| `cwd` | The folder, which names the project by its git remote. Only the project key leaves the computer. |
| `prompt` | For `prompt` events. It is scored for effort and repeats on the computer, then thrown away. Its text is never stored or sent. |
| `tokens_in`, `tokens_out`, `lines_added`, `lines_removed` | Optional, on `turn_end` or `edit`. |

## What helios does with an event

helios writes the event to the local journal. Once the computer is connected, it also sends the event to your site as it happens.

It never gets in your tool's way:

- It always exits 0.
- For a tool of your own, it prints nothing on stdout. A built-in harness gets the one reply it needs there, such as Cursor's `{"continue":true}`.
- If an event can't be written, the reason goes to stderr.

## Test an adapter

`helios hook -check <tool>` prints the record a payload would make and writes nothing.

## Connect your tool

- **A tool with a hooks file in Claude Code's shape:** point its prompt and stop hooks at `helios hook mytool`.
- **A tool with plugins:** run the same command from the plugin, as helios's own Amp plugin does with `helios hook amp`.
