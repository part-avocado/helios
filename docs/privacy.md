# Privacy

Chat logs and prompt text never leave your computer.

## What helios reads

helios reads timestamps, token counts, line counts, and working folders from your logs.

Prompt text is only scored in memory, to count recognized words. It is never stored or printed, and `sync` never uploads it.

## What it sends to your website

In Amp's cloud, the plugin sends your website each prompt's time, thread, folder, repository, and word counts, without its text. Every other harness's hooks send the same kind of record.

## What the website keeps

- **Records.** The website keeps these records in R2 for good.
- **Reports.** The website keeps each report your computers send, which holds those counts and times, so reviewers can read it. Deleting your account deletes them.
- **Your public profile.** It shows your hours, your days, and the projects it names to anyone, unless you make it private.

## See for yourself

To see exactly what leaves your computer, do either of these:

- Run `helios sync -dry-run`. It prints the records the next sync would send, and sends nothing.
- Pipe a hook payload into `helios hook -check <tool>`.
