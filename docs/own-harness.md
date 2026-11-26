# Add your own harness

Any tool can report to teardrop. Run `teardrop hook <tool>`, where the tool name is lowercase letters, digits, and dashes, with one JSON object on stdin:

```
{"session_id": "abc123", "cwd": "/home/me/project", "hook_event_name": "prompt", "prompt": "add a login page"}
```

| Field | Meaning |
| --- | --- |
| `session_id` | Required. One conversation or thread. |
| `hook_event_name` | Required, or pass `-event`: `prompt`, `turn_end`, `session_start`, `session_end`, or `edit`. |
| `cwd` | The folder, which names the project by its git remote. Only the project key leaves the computer. |
| `prompt` | For `prompt`: scored for effort and repeats on the computer, then thrown away. Its text is never stored or sent. |
| `tokens_in`, `tokens_out`, `lines_added`, `lines_removed` | Optional, on `turn_end` or `edit`. |

teardrop always exits 0 and prints nothing on stdout for a tool of your own, so it never gets in the tool's way. A built-in harness gets the one reply it needs there, such as Cursor's `{"continue":true}`, and if an event can't be written, the reason goes to stderr. It writes the event to the local journal, and, once the computer is connected, sends it to your site as it happens. `teardrop hook -check <tool>` prints the record a payload would make and writes nothing, for testing an adapter.

For a tool with a hooks file in Claude Code's shape, point its prompt and stop hooks at `teardrop hook mytool`. For a tool with plugins, run the same command from the plugin, as teardrop's own Amp plugin does with `teardrop hook amp`.
