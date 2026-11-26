# The report

Run `helios` to see the last 7 days, or `helios -since 30d` for longer. The first table lists work blocks; the second totals each project. Add `-l` (or `--live`) to keep it on screen and update it as you work; press Ctrl-C to quit.

| Column | Meaning |
| --- | --- |
| ENGAGED | Time you were plausibly involved. This is the number that matters. |
| SPAN / SESSION TIME | Wall-clock time from first to last activity, for comparison. |
| PROMPTS | Prompts you sent that counted. |
| SKIPPED | Prompts that earned no time. |
| TOKENS IN/OUT | Tokens the model read (cached ones included) and wrote. |
| TOOLS | Which AI tools you used in that block. |

A project is identified by its git remote, then its repository folder, then its working folder, so the same repo adds up across tools and clones. A folder in your home folder is written from it, as `~/code/app` (and your home folder itself as `home`), so the key your site sees doesn't name your account on the computer. Projects that were keyed by their full folder before helios did this show up twice on your site: the old key holds the time from before, the new one the time since, and no time counts twice. Add `-json` to get the report as data.
