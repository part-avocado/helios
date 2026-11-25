<!--
Not published. The docs page on the site is built only from the files
directly in docs/, so this folder stays in the source and off the site.
It says how time is counted and checked, which is not announced publicly.
-->

# What counts

teardrop counts the time you spend working with your AI tools: writing prompts, reading replies, and steering the agent. An agent left running on its own doesn't earn time, and parallel sessions on one project count once. Prompts that don't reflect real work aren't counted; they're listed as **SKIPPED**, with how many each of these checks skipped:

- **Keyboard mashing.** A prompt where more than half the words look typed at random rather than written: no vowels, one key held down, a few keys over and over, or letters in an order no language uses. Words in any language count as writing, with or without their accents, and so do code and file names.
- **Repeats.** Asking for nearly the same thing a third time within your last 5 prompts. The first two asks count.
- **Steering only.** A third prompt in a row that only steers, such as "continue", "yes", "fix it", or "still broken". The first two count, and any prompt that asks for something new starts over.

The report says how many prompts each check skipped, not which prompts.

The rules, applied to each session's prompts and agent output in time order: before a prompt, the last 5 minutes of the gap count (reading the reply, writing the prompt); while the agent works, the gap counts for up to 5 minutes after your last prompt: the first 3 minutes in full and the next 2 at half, so a prompt that starts a long agent run earns 4 minutes at most. Work blocks closer than 15 minutes are shown as one. Time between prompts beyond those caps isn't counted, and commits earn no time by themselves. Reviewers see your commits, and whether GitHub has them as you claim, beside your time. Your site stamps each day's totals with the version of these rules (currently 2), and keeps every record, so a day can be counted again if the rules change.

`teardrop calibrate` shows how the caps treat your own logs: how long your gaps before prompts and before agent output are, how many run past the caps, and your engaged total under other caps. It reads only your computer's logs and uploads nothing. Two things differ between your site and the local count: time on two computers at once counts once on your site, and a Claude Code reply you interrupt runs no hook, so its end reaches your site late and up to 4 minutes of it is unwitnessed.

## Witnessed time

Your site splits your time in two. Time whose records reached it within 5 minutes of when they happened is witnessed. Time that arrived late, such as history from before your hooks were set up or work done offline, is unwitnessed: it is shown, kept apart, and never mixed in. Programs that pay or credit hours read both through the [Stats API](run-server.md#stats-api) and decide what counts; teardrop itself credits nothing.

Witnessing stops backdating and editing after the fact. It can't stop a script that sends made-up records live, which no tracker on your own computer can rule out, so the Stats API can also list flags: more than 16 witnessed hours in a day, more than 14 hours in any 24, more than 16 hours of activity without a 2-hour break, gaps between prompts that barely or hardly vary, many prompts sent within 15 seconds of the agent's reply, many prompts or all of them never answered, and Amp turns with no tokens. A flag only asks someone to look.

## Clocks

The site credits a record only when it arrives within 5 minutes of the time it says it happened, and refuses records dated more than 5 minutes ahead of its own clock. So each computer's clock is corrected, by 5 minutes at most: the records it sends say when they were sent, and once an offset has held for a day the site pins it for that computer. It never takes a batch's word for its own offset, so records sent late stay late. A clock more than 5 minutes off is not corrected past that: its records count as unwitnessed, reviewers see which ones came from it, and a neoadmin may still accept that time. `teardrop sync` compares the two clocks and warns from 2 minutes off. Turn on setting the time automatically in your system's date and time settings, then sync again.

## teardrop calibrate

| Command | What it does |
| --- | --- |
| `teardrop calibrate` | Show how the time model's caps treat your logs (`-since 30d`). Uploads nothing. |
