# Troubleshooting

Start with `helios doctor`. It checks for the usual causes below and prints what to run for each problem it finds.

## “No Claude Code, Codex, or Amp sessions found”

- Run `helios setup` to see where helios looked.
- If your logs live somewhere else, such as inside WSL on Windows, pass `-claude-dir` or `-codex-dir`.
- If your last session was more than a week ago, try `-since 30d`.

## “helios: command not found”

Open a new terminal so the PATH change applies.

On Windows, the PowerShell window you installed from already has it. Restart any other terminal that was open during the install.

## “skipped N log files that could not be read”

Run `helios -verbose` to list them. Usually they are files a tool is still writing, and the rest of the report is unaffected.

## My time doesn't show on the website

1. Run `helios status`. It shows the account this computer syncs to, what is waiting to send, and when it last synced.
2. If it isn't connected, connect it: on the site, open Settings, Setup, and follow the steps.
3. On the site, open Settings, Computers. Each computer that has synced is listed there with when it last did. If this one is missing, run `helios sync` and read what it says.

If the server answers that it needs your sync key, the key was revoked. Run `helios login` again.

## My Amp cloud threads aren't counted

See [Check that it works](amp.md#amp-cloud-check). The “Cloud sessions” key under Settings, Setup tells you whether Amp reached your site at all.

## “Your clock is N minutes ahead of (or behind) the site's”

The site expects each computer's clock to be close to its own. `helios sync` warns once the two are 2 minutes apart.

In your system's date and time settings, turn on setting the time automatically. Then sync again.

## My hours look too low or too high

Compare ENGAGED with how long you think you worked, and please [open an issue](https://github.com/part-avocado/helios/issues) with the numbers.
