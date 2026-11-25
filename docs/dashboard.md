# The dashboard

The dashboard shows an activity heatmap, daily totals, projects, tools, and recent work blocks. There are two ways to open it.

The graphs are interactive. Hover a day, bar, or tool for the details. Click a day on the heatmap, or a bar, to list that day's work blocks (a week, on the yearly chart). Click a project in the table to see only that project; every number and chart follows it. Click again, or the chip at the top, to clear it.

<a id="account"></a>
## On the website, with an account

The [dashboard on the website](../site/dashboard.html) adds up the hours from every computer you code on. Only you and your server's reviewers can see the dashboard; your [public profile](#profile) shows a summary to anyone.

1. Open the [dashboard](../site/dashboard.html) and sign in with Hack Club. Your first sign-in creates your account.
2. Run the command the dashboard shows, then type the code your terminal prints on the site. That connects this computer to your account; do the same on each computer you code on.
3. Keep working. The page fills in as soon as the first sync arrives, and teardrop syncs again each time a reply finishes in Claude Code or Amp, or you stop one. Run `teardrop sync` to update it right away.

The [Projects](../site/projects.html) page, linked at the top of the site, lists every project you've worked on; open one to see that project on its own.

[Settings](../site/settings.html) has the rest:

| Pane | What it's for |
| --- | --- |
| Setup | What to run to connect another computer; your sync keys, one per computer, each of which you can revoke alone; and a button to make a new account key, for Amp cloud threads, if it gets out. |
| Computers | Each computer that syncs to you and when it last did. Remove one to drop its hours. |
| Data | Upload a stats file from a computer that can't reach the website (make it with `teardrop export -o stats.json`, and upload it within 7 days), or download a copy of everything the site holds about you. |
| Account | Your name, Slack ID, and member-since date from Hack Club Auth, sign out, and deleting your account. Deleting removes every computer and all of your stats from the site. |

You can sign out from the menu at the top right of any page. A computer syncs to one account. To move it to another, remove it under Computers first.

## On your computer, without an account

Run `teardrop dashboard` to open the same charts with live data from this computer, refreshed every 30 seconds. It runs on `localhost` only and refuses requests from other sites, so your stats never leave your computer.

<a id="profile"></a>
## Your public profile

Every account has a public profile at `/@handle`, which anyone can open without signing in. It shows your handle, the month you joined, your hours in the past year, a year of days, and your projects. It never shows your name, your Slack ID, or a folder on your computer. A project that is a repository on a public host, such as `github.com/you/site`, is named and linked; any other project is only counted, as one of your other projects. Under Settings, Profile, you can change your handle, hide or name each project, or make the profile private. Settings, Profile also has a badge of your hours to paste into a README, linked to your profile. A private profile, like a banned or deleted account, answers "no such profile", so its address doesn't say that the account exists.

Each account starts with a neutral handle, such as `u-3f9a0c12b4d1`, never one made from your name. When you change it, the old address stops working.

<a id="verification-keys"></a>
## Verification keys

Every sync and export carries a verification key: an Ed25519 signature, made by your account, over the report's numbers, the time it was made, and the time it expires. Change one minute of engaged time, the account, or a date, and the key no longer matches. The website refuses a report that:

- has no key, or a key that doesn't match its contents;
- is more than 7 days old, so an old or reused file can't stand in for current numbers;
- claims to be made in the future, or contains activity after the time it was made.

Each computer's key is created the first time it syncs or exports and kept in teardrop's data folder as `account.key`. Settings lists your computers by the ID of that key, such as `td-4283292a8f76`.

> [!WARNING]
> Verification proves a file wasn't edited after `teardrop export` made it. Because the account key lives on your computer, a file alone can't prove the numbers are real. For hours that count, [sync](sync.md): the site marks as witnessed only time whose records reached it as it happened.
