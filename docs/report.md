# The report

Run `helios` to see the last 7 days, or `helios -since 30d` for longer. It prints two tables: the first lists your work blocks, and the second totals each project.

| Column | Meaning |
| --- | --- |
| ENGAGED | Time you were plausibly involved. This is the number that matters. |
| SPAN / SESSION TIME | Wall-clock time from first to last activity, for comparison. |
| PROMPTS | Prompts you sent that counted. |
| SKIPPED | Prompts that earned no time. |
| TOKENS IN/OUT | Tokens the model read (cached ones included) and wrote. |
| TOOLS | Which AI tools you used in that block. |

Two flags change how the report comes out:

- `-l` (or `--live`) keeps it on screen and updates it as you work. Press Ctrl-C to quit.
- `-json` prints the report as data.

## How a project is named

helios names a project by the first of these that it has:

1. its git remote;
2. its repository folder;
3. its working folder.

So the same repository adds up across tools and clones.

A folder inside your home folder is written starting from it, as `~/code/app`, and your home folder itself is written as `home`. That way the project key your site sees doesn't name your account on the computer.

Older versions of helios used the full folder path as the key. Projects recorded that way show up twice on your site: the old key holds the time from before the change, and the new key holds the time since. No time counts twice.
