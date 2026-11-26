# Install

## macOS, Linux, and Git Bash on Windows

```
curl -fsSL https://raw.githubusercontent.com/part-avocado/teardrop/main/install.sh | sh
```

## Windows (PowerShell)

```
irm https://raw.githubusercontent.com/part-avocado/teardrop/main/install.ps1 | iex
```

The installer downloads the right binary, checks it against the release's `checksums.txt` (it needs `sha256sum`, `shasum`, or `openssl` for that, and installs nothing without one), and installs it without admin rights to `~/.local/bin`, or `%LOCALAPPDATA%\Programs\teardrop` on Windows. It adds that folder to your PATH, then runs `teardrop setup`. The first command writes the PATH change to your shell's profile, so open a new terminal before you run `teardrop` yourself. The PowerShell one also adds the folder to the window you installed from, so `teardrop` works there straight away; restart any other terminal that was already open.

## Updating

To update later, run `teardrop update`, or run the install command again. `teardrop update -check` only says whether a newer version is out, and `teardrop update v0.5.0` installs one version in particular, even an older one. `teardrop update` and the installer both run `teardrop setup` again with the new version, to bring hooks and plugins up to date.

Once a day, a background sync checks for a newer release, and `teardrop` prints one line when there is one. teardrop updates itself only if you run `teardrop update -auto on`: then that daily check installs each new release once it matches the release's checksums and runs as that version, keeps the one it replaced beside it with `.old` on the end, and says so for three days. Run `teardrop setup` after an update like this to bring hooks and plugins up to date. The checksums come from the same release as the binary, so auto-update trusts GitHub and teardrop's release workflow as much as the installer does. `teardrop update -auto off` stops it.

## Installer options

These optional environment variables change what the installer does:

| Variable | Effect |
| --- | --- |
| `TEARDROP_VERSION` | Install a specific release, such as `v0.1.0`. |
| `TEARDROP_INSTALL_DIR` | Install to another folder. |
| `TEARDROP_NO_MODIFY_PATH` | Don't edit your shell profile or PATH; print the line to add instead. |
| `TEARDROP_NO_SETUP` | Don't run `teardrop setup` afterwards. |
| `TEARDROP_CLOUD` | Set to `1` in a cloud environment, Codespace, or dev container: sets up Claude Code and every other tool found, without asking. Also set `TEARDROP_SERVER` and `TEARDROP_KEY` there; see [Claude Code in the cloud](claude-code.md#claude-code-in-the-cloud-codespaces-and-remote-machines). |
| `TEARDROP_BASE_URL` | Download the binary and `checksums.txt` from this URL instead of the GitHub release, such as a mirror. |

With Go 1.25 or later you can also run `go install github.com/part-avocado/teardrop/cmd/teardrop@latest`.
