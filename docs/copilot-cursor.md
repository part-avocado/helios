# Copilot and Cursor

`teardrop setup` writes `~/.copilot/hooks/teardrop.json` for GitHub Copilot CLI and VS Code's Copilot agent, and adds teardrop's hooks to `~/.cursor/hooks.json` for Cursor, keeping any hooks of your own. Restart Cursor to load them. Neither keeps transcripts teardrop can read, so their time comes from the hooks alone, and only reaches your site when one is set up with `teardrop sync`.

Copilot CLI's hooks name no session, so teardrop names one after the folder it runs in: a hash of its path, never the path itself.

## Remote machines and the cloud

On an SSH box, Codespace, or cloud container, set teardrop up as for [Claude Code](claude-code.md#claude-code-in-the-cloud-codespaces-and-remote-machines): with `TEARDROP_CLOUD=1` the installer sets up Copilot and Cursor too, where their `~/.copilot` or `~/.cursor` folder exists. If Copilot has not made its folder yet, run `teardrop setup -yes copilot`, which makes it. Their hooks then send each event straight to your site.
