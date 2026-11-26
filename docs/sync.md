<a id="server"></a>
# Sync

`helios sync` sends your account records: one per prompt and turn end, with its time, word counts, tokens, and lines, never its text. The first sync sends the past year; later ones send only what changed. The first time, connect the computer:

```
helios login -server https://your-site
```

It prints a code such as `BCDF-GHJK` and opens the site's connect page; sign in, type the code, and check that the computer ID it shows matches the one in your terminal. helios then saves a sync key of this computer's own and syncs. Each computer gets its own key, listed under Settings, Setup, by its computer ID, so you can revoke one without touching the rest. A code lasts 10 minutes and works once. It has to be typed rather than followed from a link, so nobody can send you a link that connects their computer to your account. Never type a code someone sent you: the page says when and from where each code was asked for, and allowing one gives that computer a sync key to your account. On a computer with no browser, make a sync key for it under [Settings](../site/settings.html), Setup, and run `helios sync -server https://your-site -key tdk_…` there.

helios remembers the server and the key, so later it's just `helios sync`, and hooks sync in the background when a reply finishes or you stop one. Amp reports a stopped reply at once; Claude Code runs no hook then, so that sync happens at your next prompt or when the session closes. Codex syncs through its `notify` program when a turn ends. The key only sends records; it can't read or change your account or settings. If the server answers that it needs your sync key, run `helios login` again.

Programs that pay or credit hours read your time through the [Stats API](run-server.md#stats-api) and decide what counts; helios itself credits nothing.

Your stats on the website are visible to you and to reviewers, apart from what your [public profile](dashboard.md#profile) shows: a reviewer sees, for each project, your total and a timeline of your work blocks (when each started and ended, with its prompts, tokens, and lines changed), and neoadmins and superadmins see everything you synced. Deleting your account, under Settings, removes them; admins keep your Slack ID and a record of what your computers reported, without project names. To host the site, see [Running a server](run-server.md).
