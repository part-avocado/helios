<a id="server"></a>
# Sync

`helios sync` sends your records to your account on the site. There is one record for each prompt and each turn end. A record holds its time, word counts, tokens, and lines, never its text.

The first sync sends the past year. Later ones send only what changed.

## Connect a computer

Before a computer can sync, connect it:

```
helios login -server https://your-site
```

1. helios prints a code such as `BCDF-GHJK` and opens the site's connect page.
2. Sign in and type the code.
3. Check that the computer ID on the page matches the one in your terminal.

helios then saves a sync key for this computer and syncs. Each computer gets its own key. They are listed under Settings, Setup, by computer ID, so you can revoke one without touching the rest.

A code lasts 10 minutes and works once. It has to be typed, not followed from a link, so nobody can send you a link that connects their computer to your account.

> [!WARNING]
> Never type a code someone sent you. Allowing a code gives that computer a sync key to your account. The connect page says when and from where each code was asked for.

### A computer with no browser

Make a sync key for it under [Settings](../site/settings.html), Setup. Then run this on that computer:

```
helios sync -server https://your-site -key tdk_…
```

## After the first sync

helios remembers the server and the key, so later it's just `helios sync`.

Hooks also sync in the background when a reply finishes or you stop one:

- **Amp** reports a stopped reply at once.
- **Claude Code** runs no hook when you stop a reply, so that sync happens at your next prompt or when the session closes.
- **Codex** syncs through its `notify` program when a turn ends.

The key only sends records. It can't read or change your account or settings. If the server answers that it needs your sync key, run `helios login` again.

## Who can see your stats

On the website, your stats are visible to you and to reviewers. Beyond that, anyone can see what your [public profile](dashboard.md#profile) shows.

- **A reviewer** sees, for each project, your total and a timeline of your work blocks: when each started and ended, with its prompts, tokens, and lines changed.
- **Neoadmins and superadmins** see everything you synced.

Deleting your account, under Settings, removes your stats. Admins keep your Slack ID and a record of what your computers reported, without project names.

## Who credits your hours

helios itself credits nothing. Programs that pay or credit hours read your time through the [Stats API](run-server.md#stats-api) and decide what counts.

To host the site yourself, see [Running a server](run-server.md).
