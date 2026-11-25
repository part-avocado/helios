# Amp

Amp keeps threads on its servers, so `teardrop setup` (or `teardrop setup amp` for Amp alone) offers to write a plugin to `~/.config/amp/plugins/teardrop.ts`. It records when a thread starts, when you send a prompt, and when Amp finishes, in the same journal as the Claude Code hooks. New Amp threads load it automatically; in open ones, run `plugins: reload`.

<a id="amp-cloud"></a>
## Threads in Amp's cloud

Threads you start in the Amp app or on ampcode.com run in Amp's cloud, not on your computer, so that plugin can't see them. A second plugin, [`teardrop-cloud.ts`](https://github.com/part-avocado/teardrop/blob/main/amp/teardrop-cloud.ts), counts them. It goes in your personal Amp plugins, which Amp loads in every cloud thread.

1. On your teardrop site, open Settings, Setup, and choose Amp under “Check your tools”.
2. Paste the prompt shown there into any Amp thread. Amp adds the plugin and two values to its Secrets & Env Vars settings: `TEARDROP_SERVER`, your site's address, and `TEARDROP_KEY`, a sync key. Make it with **Make a key for Amp** under the prompt; it shows once, and is listed under your sync keys as "Amp cloud". Amp asks you for the key in a private dialog, so it stays out of the thread.

In a cloud thread, the plugin downloads teardrop, checks it against the release's checksum, and runs it when you send a prompt and when Amp finishes. Each run sends your site one line: the time, thread, folder, repository, and the prompt's word counts and fingerprint, never its text. When Amp finishes, the line also holds the tokens the turn used and the lines its file edits added and removed, never the code. Your site keeps these lines for a year. At the end of each turn teardrop also sends your commits in the thread's repository, as `teardrop sync` does on a computer, so they show in the review app's graphs and can be checked against GitHub.

No computer of yours is needed. When Amp finishes a turn or you stop it, the teardrop in that thread reads all of your cloud lines back from your site, counts them with the same rules as everything else, and syncs the result. Threads that ran side by side are counted together, so their overlap counts once. Your cloud threads show up as one entry under Settings, Computers, named “Amp cloud threads”.

> [!NOTE]
> Cloud time reaches your dashboard when Amp finishes a turn or you stop it. Its days are split at midnight UTC, because a cloud thread doesn't know your time zone. The Mac app's threads can also run on your Mac instead of the cloud: open the app's App Settings, Runner, turn it on, and pick “This Mac” when you start a thread. Those are recorded by the first plugin.

<a id="agent-prompt"></a>
## Set up with a prompt

The dashboard's setup steps include a prompt to paste into Amp or Claude Code, with your server already filled in. The agent installs teardrop, runs `teardrop setup -yes` to add the hooks and the plugin without stopping to ask, runs `teardrop login` and shows you the code to type on the site, and shows you the result. `-yes` is the part an agent can't do on its own, since setup otherwise asks before changing any settings. The prompt holds no key, so nothing secret ends up in that thread.
