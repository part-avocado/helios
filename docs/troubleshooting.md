# Troubleshooting

Start with `teardrop doctor`. It checks the usual causes below and prints what to run for each one it finds.

## “No Claude Code or Codex sessions found”

Run `teardrop setup` to see where teardrop looked. If your logs live elsewhere, such as inside WSL on Windows, pass `-claude-dir` or `-codex-dir`. Try `-since 30d` if your last session was more than a week ago.

## “teardrop: command not found”

Open a new terminal so the PATH change applies. On Windows, restart any terminal that was open during install.

## “skipped N log files that could not be read”

Run `teardrop -verbose` to list them. Usually they are files a tool is still writing, and the rest of the report is unaffected.

## “Your clock is N minutes ahead of (or behind) the site's”

The site credits a record only when it arrives within 5 minutes of the time it says it happened, and refuses records dated more than 5 minutes ahead of its own clock. So each computer's clock is corrected, by 5 minutes at most: the records it sends say when they were sent, and once an offset has held for a day the site pins it for that computer. It never takes a batch's word for its own offset, so records sent late stay late. A clock more than 5 minutes off is not corrected past that: its records count as unwitnessed, reviewers see which ones came from it, and a neoadmin may still accept that time. `teardrop sync` compares the two clocks and warns from 2 minutes off. Turn on setting the time automatically in your system's date and time settings, then sync again.

## My hours look too low or too high

Compare ENGAGED with how long you think you worked, and please [open an issue](https://github.com/part-avocado/teardrop/issues) with the numbers.
