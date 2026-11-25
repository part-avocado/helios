# Privacy

teardrop reads timestamps, token counts, line counts, and working folders from your logs. Prompt text is only scored in memory to count recognized words; it is never stored or printed, and `sync` never uploads it. In Amp's cloud, the plugin sends your website each prompt's time, thread, folder, repository, and word counts, without its text, and every other harness's hooks send the same kind of record. The website keeps these records in R2 for good. The website keeps each report your computers send, which holds those counts and times, so reviewers can read it; deleting your account deletes them. Your public profile shows your hours, your days, and the projects it names to anyone, unless you make it private. Chat logs and prompt text never leave your computer.

To see exactly what leaves your computer, run `teardrop sync -dry-run`, which prints the records the next sync would send and sends nothing, or pipe a hook payload into `teardrop hook -check <tool>`.
