# Antigravity

`teardrop setup` (or `teardrop setup antigravity`) offers to add a `teardrop` group to Antigravity's global hooks file, `~/.gemini/config/hooks.json`. The App, the CLI, and the IDE all read it. Your other hook groups are kept.

The group runs `teardrop hook antigravity` on three events:

| Event | Recorded as |
| --- | --- |
| `SessionStart` | the session starting |
| `PreInvocation`, on an execution's first model call | your prompt, scored for effort and repeats, then thrown away |
| `Stop` | the turn ending |

Antigravity runs `PreInvocation` before every model call. Only the first call of an execution follows a prompt of yours, so teardrop skips the rest. Antigravity's hooks report no tokens, so its turns show no token counts.

Each hook prints `{}`, which is what Antigravity needs from a hook that changes nothing. To check that it loaded them, open the agent side panel, then Customizations, then Hooks. In the CLI, run `/hooks`.

`teardrop setup -remove-hooks antigravity` takes the group out again. For Antigravity on a remote machine, see [Remote sessions](cloud.md).
