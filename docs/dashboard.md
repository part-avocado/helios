# The dashboard

The dashboard shows an activity heatmap, daily totals, projects, tools, and recent work blocks. You can open it [on the website](#account), with an account, or [on your computer](#local), without one.

## Reading the graphs

The graphs are interactive:

- **Hover** a day, bar, or tool for the details.
- **Click a day** on the heatmap, or a bar, to list that day's work blocks. On the yearly chart, a bar lists a week.
- **Click a project** in the table to see only that project. Every number and chart follows it. Click it again, or the chip at the top, to clear it.

<a id="account"></a>
## On the website, with an account

The [dashboard on the website](../site/dashboard.html) adds up the hours from every computer you code on. Only you and your server's reviewers can see it. Your [public profile](#profile) shows a summary to anyone.

1. Open the [dashboard](../site/dashboard.html) and sign in with Hack Club. Your first sign-in creates your account.
2. Run the command the dashboard shows. Your terminal prints a code; type it on the site. That connects this computer to your account. Do the same on each computer you code on.
3. Keep working. The page fills in as soon as the first sync arrives. helios syncs again each time a reply finishes in Claude Code or Amp, or you stop one. Run `helios sync` to update it right away.

### Projects

The [Projects](../site/projects.html) page lists every project you've worked on. Open one to see that project on its own. A project's page also has its settings:

- **Public**: whether your [public profile](#profile) names it.
- The GitHub repositories linked to it, which you can add or remove.

### Settings

[Settings](../site/settings.html) has the rest:

| Pane | What it's for |
| --- | --- |
| Setup | What to run to connect another computer, and your sync keys. A sync key only uploads stats. Each computer gets its own, and cloud sessions (Claude Code in the cloud, Amp threads) get one named "Cloud sessions". Revoke one and only it stops working. |
| Computers | Each computer that syncs to you and when it last did. Remove one to drop its hours. |
| Data | Upload a stats file from a computer that can't reach the website, or download a copy of everything the site holds about you. Make the stats file with `helios export -o stats.json`, and upload it within 7 days. |
| Account | Your name, Slack ID, and member-since date from Hack Club Auth, signing out, and deleting your account. Deleting removes every computer and all of your stats from the site. |

You can sign out from the sidebar, or on a narrow window from the menu at the top right.

A computer syncs to one account. To move it to another, remove it under Computers first.

<a id="local"></a>
## On your computer, without an account

Run `helios dashboard` to open the same charts with live data from this computer, refreshed every 30 seconds. It runs on `localhost` only and refuses requests from other sites, so your stats never leave your computer.

<a id="profile"></a>
## Your public profile

Every account has a public profile at `/@handle`, which anyone can open without signing in.

It shows your handle, the month you joined, your hours in the past year, a year of days, and your projects. It never shows your name, your Slack ID, or a folder on your computer.

### Which projects it names

- A project that is a repository on a public host, such as `github.com/you/site`, is public by default. The profile names it and links to its repositories.
- Any other project is only counted, as one of your other projects, until you make it public.

Turn **Public** on or off on each project's page.

### Your handle

Each account starts with a neutral handle, such as `u-3f9a0c12b4d1`, never one made from your name. When you change it, the old address stops working.

### Profile settings

Under Settings, Profile, you can:

- change your handle;
- make the whole profile private;
- copy a badge of your hours to paste into a README, linked to your profile.

A private profile answers "no such profile", as a banned or deleted account does. So its address doesn't say that the account exists.

<a id="verification-keys"></a>
## Verification keys

Every sync and export carries a verification key. It is an Ed25519 signature, made by your account, over the report's numbers, the time it was made, and the time it expires. Change one minute of engaged time, the account, or a date, and the key no longer matches.

The website refuses a report that:

- has no key, or a key that doesn't match its contents;
- is more than 7 days old, so an old or reused file can't stand in for current numbers;
- claims to be made in the future, or contains activity after the time it was made.

Each computer's key is created the first time it syncs or exports. It is kept in helios's data folder as `account.key`. Settings lists your computers by the ID of that key, such as `td-4283292a8f76`.

> [!WARNING]
> Verification proves a file wasn't edited after `helios export` made it. Because the account key lives on your computer, a file alone can't prove the numbers are real. For hours that count, [sync](sync.md).
