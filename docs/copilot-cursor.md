# Copilot and Cursor

`teardrop setup` writes `~/.copilot/hooks/teardrop.json` for GitHub Copilot CLI and VS Code's Copilot agent, and adds teardrop's hooks to `~/.cursor/hooks.json` for Cursor, keeping any hooks of your own. Restart Cursor to load them. Neither keeps transcripts teardrop can read, so their time comes from the hooks alone, and only reaches your site when one is set up with `teardrop sync`.
