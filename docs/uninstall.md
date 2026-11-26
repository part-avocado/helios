# Uninstall

```
helios uninstall
```

It asks once, then removes helios's hooks from Claude Code, Codex, Cursor, and Copilot, its Amp and OpenCode plugins, and the line the installer added to your shell profile (on Windows, the folder it added to your Path), leaving your other settings and lines as they were. It asks whether to keep the journal folder, which holds this computer's account key and any records not sent yet, and deletes the binary last. Windows can't delete a running program, so there it tells you to delete `helios.exe` once the window closes. `-yes` answers every question, deleting the journal folder unless you add `-keep-data`.

Your account on the site keeps what it has; remove the computer under Settings, Computers. Claude Code's longer history setting and helios's `.helios-backup` copies of settings files stay. To remove only the hooks and keep helios, run `helios setup -remove-hooks`.
