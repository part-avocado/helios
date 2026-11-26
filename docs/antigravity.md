# Antigravity

`helios setup` (or `helios setup antigravity`) offers to add a `helios` group to Antigravity's global hooks file, `~/.gemini/config/hooks.json`. The App, the CLI, and the IDE all read that file. Your other hook groups are kept.

## What the hooks record

The group runs `helios hook antigravity` on three events:

| Event | Recorded as |
| --- | --- |
| `SessionStart` | the session starting |
| `PreInvocation`, on an execution's first model call | your prompt, scored for effort and repeats, then thrown away |
| `Stop` | the turn ending |

Two things to know:

- Antigravity runs `PreInvocation` before every model call. Only the first call of an execution follows a prompt of yours, so helios skips the rest.
- Antigravity's hooks report no tokens, so its turns show no token counts.

Each hook prints `{}`, which is what Antigravity needs from a hook that changes nothing.

## Check that the hooks loaded

In the app, open the agent side panel, then Customizations, then Hooks. In the CLI, run `/hooks`.

## Remove the hooks

`helios setup -remove-hooks antigravity` takes the group out again.

For Antigravity on a remote machine, see [Remote sessions](cloud.md).
