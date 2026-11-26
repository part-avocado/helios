# Amp

Amp keeps threads on its servers, so helios can't read them from your computer. Instead, `helios setup` (or `helios setup amp` for Amp alone) offers to write a plugin to `~/.config/amp/plugins/helios.ts`.

The plugin records when a thread starts, when you send a prompt, and when Amp finishes. It writes to the same journal as the Claude Code hooks.

New Amp threads load the plugin automatically. In threads that are already open, run `plugins: reload`.

<a id="amp-cloud"></a>
## Threads in Amp's cloud

Threads you start in the Amp app or on ampcode.com run in Amp's cloud, not on your computer, so that plugin can't see them. A second plugin, [`helios-cloud.ts`](https://github.com/part-avocado/helios/blob/main/amp/helios-cloud.ts), counts them. It goes in your personal Amp plugins, which Amp loads in every cloud thread.

### Set it up

1. On your helios site, open Settings, Setup, and choose Amp under “Check your tools”.
2. Make a sync key with **Make a key for Amp**, under the prompt shown there. It shows once, and is listed under your sync keys as "Cloud sessions".
3. Paste the prompt into any Amp thread. Amp adds the plugin and two values to its Secrets & Env Vars settings: `HELIOS_SERVER`, your site's address, and `HELIOS_KEY`, the sync key. Amp asks you for the key in a private dialog, so it stays out of the thread.

### What the plugin does

In a cloud thread, the plugin downloads helios and checks it against the release's checksum. It then runs helios when you send a prompt and when Amp finishes. Each run sends your site one line:

- **Every line** holds the time, thread, folder, repository, and the prompt's word counts and fingerprint, never its text.
- **When Amp finishes**, the line also holds the tokens the turn used and the lines its file edits added and removed, never the code.

Your site keeps these lines for a year.

At the end of each turn helios also sends your commits in the thread's repository, as `helios sync` does on a computer. So they show in the review app's graphs and can be checked against GitHub.

### How cloud time is counted

No computer of yours is needed. When Amp finishes a turn or you stop it, the helios in that thread:

1. reads all of your cloud lines back from your site;
2. counts them with the same rules as everything else;
3. syncs the result.

Threads that ran side by side are counted together, so their overlap counts once.

Your cloud threads show up as one entry under Settings, Computers, named “Cloud sessions”.

> [!NOTE]
> Cloud time reaches your dashboard when Amp finishes a turn or you stop it. Its days are split at midnight UTC, because a cloud thread doesn't know your time zone.

### Threads on your Mac

The Mac app's threads can also run on your Mac instead of the cloud. Open the app's App Settings, Runner, turn it on, and pick “This Mac” when you start a thread. Those threads are recorded by the first plugin.

<a id="agent-prompt"></a>
## Set up with a prompt

The dashboard's setup steps include a prompt to paste into Amp or Claude Code, with your server already filled in. The agent then:

1. installs helios;
2. runs `helios setup -yes`, to add the hooks and the plugin without stopping to ask;
3. runs `helios login` and shows you the code to type on the site;
4. shows you the result.

`-yes` is what lets an agent finish setup, since setup otherwise asks before changing any settings and an agent can't answer. The prompt holds no key, so nothing secret ends up in that thread.
