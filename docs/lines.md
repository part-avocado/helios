# Lines of code

## What helios sends about commits

When a computer syncs, helios also sends your site one record for each commit of yours, in each project with a git remote. A record holds the commit's SHA, author time, and lines added and removed, never its message or code.

Commits earn no time.

## Checking commits against GitHub

Your profile links a public repository's latest commits. Once an hour the site asks GitHub which of them exist, so a reviewer can spot a claimed commit that GitHub doesn't have.

For each commit GitHub has, the review app also:

- shows the GitHub account it is linked to;
- marks it if its claimed time differs from GitHub's author date. The SHA pins that date, so a difference means the time was changed after the commit was made.

A private repository's commits are shown as not checked.

The check needs a `GITHUB_TOKEN` secret on the Worker. Without one, the review app says so.

## Lines in the report

For each project the report shows three counts:

| Column | Meaning |
| --- | --- |
| **AGENT LINES** | The lines agents changed. |
| **KEPT** | How many of the lines agents added later turned up in your commits. |
| **COMMITTED** | The lines your own commits added. |

The code itself is not kept.
