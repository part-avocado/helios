# Install

## macOS, Linux, and Git Bash on Windows

```
curl -fsSL https://raw.githubusercontent.com/part-avocado/helios/main/install.sh | sh
```

## Windows (PowerShell)

```
irm https://raw.githubusercontent.com/part-avocado/helios/main/install.ps1 | iex
```

The installer downloads the right binary, checks it against the release's `checksums.txt` (it needs `sha256sum`, `shasum`, or `openssl` for that, and installs nothing without one), and installs it without admin rights to `~/.local/bin`, or `%LOCALAPPDATA%\Programs\helios` on Windows. It adds that folder to your PATH, then runs `helios setup`. The first command writes the PATH change to your shell's profile, so open a new terminal before you run `helios` yourself. The PowerShell one also adds the folder to the window you installed from, so `helios` works there straight away; restart any other terminal that was already open.

## Updating

To update later, run `helios update`, or run the install command again. `helios update -check` only says whether a newer version is out, and `helios update v0.5.0` installs one version in particular, even an older one. `helios update` and the installer both run `helios setup` again with the new version, to bring hooks and plugins up to date.

Once a day, a background sync checks for a newer release, and `helios` prints one line when there is one. helios updates itself only if you run `helios update -auto on`: then that daily check installs each new release once it matches the release's checksums and runs as that version, keeps the one it replaced beside it with `.old` on the end, and says so for three days. Run `helios setup` after an update like this to bring hooks and plugins up to date. The checksums come from the same release as the binary, so auto-update trusts GitHub and helios's release workflow as much as the installer does. `helios update -auto off` stops it.

## Installer options

These optional environment variables change what the installer does:

| Variable | Effect |
| --- | --- |
| `HELIOS_VERSION` | Install a specific release, such as `v0.1.0`. |
| `HELIOS_INSTALL_DIR` | Install to another folder. |
| `HELIOS_NO_MODIFY_PATH` | Don't edit your shell profile or PATH; print the line to add instead. |
| `HELIOS_NO_SETUP` | Don't run `helios setup` afterwards. |
| `HELIOS_CLOUD` | Set to `1` in a cloud environment, Codespace, or dev container: sets up Claude Code and every other tool found, without asking. Also set `HELIOS_SERVER` and `HELIOS_KEY` there; see [Claude Code in the cloud](claude-code.md#claude-code-in-the-cloud-codespaces-and-remote-machines). |
| `HELIOS_BASE_URL` | Download the binary and `checksums.txt` from this URL instead of the GitHub release, such as a mirror. |

With Go 1.25 or later you can also run `go install github.com/part-avocado/helios/cmd/helios@latest`.
