# Install

## macOS, Linux, and Git Bash on Windows

```
curl -fsSL https://raw.githubusercontent.com/part-avocado/helios/main/install.sh | sh
```

## Windows (PowerShell)

```
irm https://raw.githubusercontent.com/part-avocado/helios/main/install.ps1 | iex
```

## What the installer does

1. Downloads the right binary for your computer.
2. Checks it against the release's `checksums.txt`. This needs `sha256sum`, `shasum`, or `openssl`. Without one of them, it installs nothing.
3. Installs it to `~/.local/bin`, or `%LOCALAPPDATA%\Programs\helios` on Windows. No admin rights are needed.
4. Adds that folder to your PATH.
5. Runs `helios setup`.

When `helios` starts working depends on which command you ran:

- **The first command** writes the PATH change to your shell's profile. Open a new terminal before you run `helios` yourself.
- **The PowerShell command** also adds the folder to the window you installed from, so `helios` works there straight away. Restart any other terminal that was already open.

## Updating

| Command | What it does |
| --- | --- |
| `helios update` | Installs the latest version. Running the install command again does the same. |
| `helios update -check` | Only says whether a newer version is out. |
| `helios update v0.5.0` | Installs one version in particular, even an older one. |

`helios update` and the installer both run `helios setup` again with the new version, to bring hooks and plugins up to date.

### Automatic updates

Once a day, a background sync checks for a newer release. When there is one, `helios` prints one line to say so. It installs nothing by itself.

To have helios update itself, run `helios update -auto on`. From then on, the daily check:

- installs each new release once it matches the release's checksums and runs as that version;
- keeps the version it replaced beside it, with `.old` on the end;
- says that it updated, for three days.

After an update like this, run `helios setup` to bring hooks and plugins up to date. To stop automatic updates, run `helios update -auto off`.

The checksums come from the same release as the binary. So auto-update trusts GitHub and helios's release workflow as much as the installer does.

## Installer options

These optional environment variables change what the installer does:

| Variable | Effect |
| --- | --- |
| `HELIOS_VERSION` | Install a specific release, such as `v0.1.0`. |
| `HELIOS_INSTALL_DIR` | Install to another folder. |
| `HELIOS_NO_MODIFY_PATH` | Don't edit your shell profile or PATH. Print the line to add instead. |
| `HELIOS_NO_SETUP` | Don't run `helios setup` afterwards. |
| `HELIOS_CLOUD` | Set to `1` in a cloud environment, Codespace, or dev container. It sets up Claude Code and every other tool found, without asking. Also set `HELIOS_SERVER` and `HELIOS_KEY` there; see [Claude Code in the cloud](claude-code.md#claude-code-in-the-cloud-codespaces-and-remote-machines). |
| `HELIOS_BASE_URL` | Download the binary and `checksums.txt` from this URL, such as a mirror, instead of the GitHub release. |

## Install with Go

With Go 1.25 or later you can also run `go install github.com/part-avocado/helios/cmd/helios@latest`.
