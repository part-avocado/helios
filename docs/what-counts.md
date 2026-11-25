# What counts

teardrop counts the time you spend working with your AI tools: writing prompts, reading replies, and steering the agent. An agent left running on its own doesn't earn time, and parallel sessions on one project count once. Prompts that don't reflect real work aren't counted; they're listed as **SKIPPED**, with how many each of these checks skipped:

- **Keyboard mashing.** A prompt where more than half the words look typed at random rather than written: no vowels, one key held down, a few keys over and over, or letters in an order no language uses. Words in any language count as writing, with or without their accents, and so do code and file names.
- **Repeats.** Asking for nearly the same thing a third time within your last 5 prompts. The first two asks count.
- **Steering only.** A third prompt in a row that only steers, such as "continue", "yes", "fix it", or "still broken". The first two count, and any prompt that asks for something new starts over.

The report says how many prompts each check skipped, not which prompts.

The rules, applied to each session's prompts and agent output in time order: before a prompt, the last 5 minutes of the gap count (reading the reply, writing the prompt); while the agent works, the gap counts for up to 5 minutes after your last prompt: the first 3 minutes in full and the next 2 at half, so a prompt that starts a long agent run earns 4 minutes at most. Work blocks closer than 15 minutes are shown as one. Time between prompts beyond those caps isn't counted, and commits earn no time by themselves. Reviewers see your commits, and whether GitHub has them as you claim, beside your time. Your site stamps each day's totals with the version of these rules (currently 2), and keeps every record, so a day can be counted again if the rules change.

`teardrop calibrate` shows how the caps treat your own logs: how long your gaps before prompts and before agent output are, how many run past the caps, and your engaged total under other caps. It reads only your computer's logs and uploads nothing. Two things differ between your site and the local count: time on two computers at once counts once on your site, and a Claude Code reply you interrupt runs no hook, so its end reaches your site late and up to 4 minutes of it is unwitnessed.
