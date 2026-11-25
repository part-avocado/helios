# Troubleshooting

Start with `teardrop doctor`. It checks the usual causes below and prints what to run for each one it finds.

## “No Claude Code, Codex, or Amp sessions found”

Run `teardrop setup` to see where teardrop looked. If your logs live elsewhere, such as inside WSL on Windows, pass `-claude-dir` or `-codex-dir`. Try `-since 30d` if your last session was more than a week ago.

## “teardrop: command not found”

Open a new terminal so the PATH change applies. On Windows, the PowerShell window you installed from already has it; restart any other terminal that was open during install.

## “skipped N log files that could not be read”

Run `teardrop -verbose` to list them. Usually they are files a tool is still writing, and the rest of the report is unaffected.

## “Your clock is N minutes ahead of (or behind) the site's”

The site expects each computer's clock to be close to its own, and `teardrop sync` warns from 2 minutes off. Turn on setting the time automatically in your system's date and time settings, then sync again.

## My hours look too low or too high

Compare ENGAGED with how long you think you worked, and please [open an issue](https://github.com/part-avocado/teardrop/issues) with the numbers.
