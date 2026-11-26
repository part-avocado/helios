# Uninstall

```
helios uninstall
```

It asks once, then:

1. Removes helios's hooks from Claude Code, Codex, Cursor, and Copilot, and its Amp and OpenCode plugins.
2. Removes the line the installer added to your shell profile, or on Windows the folder it added to your Path. Your other settings and lines stay as they were.
3. Asks whether to keep the journal folder, which holds this computer's account key and any records not sent yet.
4. Deletes the binary. Windows can't delete a running program, so there it tells you to delete `helios.exe` once the window closes.

`-yes` answers every question. It deletes the journal folder unless you add `-keep-data`.

## What stays behind

- **Your account on the site** keeps what it has. Remove the computer under Settings, Computers.
- **Claude Code's longer history setting** stays.
- **helios's `.helios-backup` copies** of settings files stay.

## Remove only the hooks

To remove the hooks and keep helios, run `helios setup -remove-hooks`.
