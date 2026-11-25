<a id="server"></a>
# Sync

`teardrop sync` sends your account records: one per prompt and turn end, with its time, word counts, tokens, and lines, never its text. The first sync sends the past year; later ones send only what changed. Turns your hooks already sent count as witnessed; turns from transcripts that no hook saw reach the site late and are shown but not credited. The first time, connect the computer:

```
teardrop login -server https://your-site
```

It prints a code such as `BCDF-GHJK` and opens the site's connect page; sign in, type the code, and check that the computer ID it shows matches the one in your terminal. teardrop then saves a sync key of this computer's own and syncs. Each computer gets its own key, listed under Settings, Setup, by its computer ID, so you can revoke one without touching the rest. A code lasts 10 minutes and works once. It has to be typed rather than followed from a link, so nobody can send you a link that connects their computer to your account. Never type a code someone sent you: the page says when and from where each code was asked for, and allowing one gives that computer a sync key to your account. On a computer with no browser, make a sync key for it under [Settings](../site/settings.html), Setup, and run `teardrop sync -server https://your-site -key tdk_…` there.

teardrop remembers the server and the key, so later it's just `teardrop sync`, and hooks sync in the background when a reply finishes or you stop one. Amp reports a stopped reply at once; Claude Code runs no hook then, so that sync happens at your next prompt or when the session closes. Codex syncs through its `notify` program when a turn ends. The key only sends records; it can't read or change your account or settings. If the server answers that it needs your sync key, run `teardrop login` again.

Your site splits your time in two. Time whose records reached it within 5 minutes of when they happened is witnessed. Time that arrived late, such as history from before your hooks were set up or work done offline, is unwitnessed: it is shown, kept apart, and never mixed in. Programs that pay or credit hours read both through the [Stats API](run-server.md#stats-api) and decide what counts; teardrop itself credits nothing.

Witnessing stops backdating and editing after the fact. It can't stop a script that sends made-up records live, which no tracker on your own computer can rule out, so the Stats API can also list flags: more than 16 witnessed hours in a day, more than 14 hours in any 24, more than 16 hours of activity without a 2-hour break, gaps between prompts that barely or hardly vary, many prompts sent within 15 seconds of the agent's reply, many prompts or all of them never answered, and Amp turns with no tokens. A flag only asks someone to look.

Your stats on the website are visible to you and to reviewers, apart from what your [public profile](dashboard.md#profile) shows: a reviewer sees, for each project, your total and a timeline of your work blocks (when each started and ended, with its prompts, tokens, and lines changed), and neoadmins and superadmins see everything you synced. Deleting your account, under Settings, removes them; admins keep your Slack ID and a record of what your computers reported, without project names. To host the site, see [Running a server](run-server.md).
