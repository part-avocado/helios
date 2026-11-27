# Amp

> [!Warning]
> Amp plugins are still in Beta and have very limited support. As a result, your data may be inaccurate, and you may experience issues while submitting to YSWSes. We highly recommend that you use Codex, Claude Code, or any other app that writes files to *your disk* as they are much more reliable to track.

Ampcode utilises cloud-based compute for their agents, so helios is unable to read the thread data from your computer. Instead, `helios setup` (or `helios setup amp`) will write a plugin to `~/.config/amp/plugins/helios.ts`

Amp keeps threads on its servers, so helios can't read them from your computer. Instead, `helios setup` (or `helios setup amp` for Amp alone) offers to write a plugin to `~/.config/amp/plugins/helios.ts`, allowing for usage while **using Amp on your desktop app**. This variant of the Amp plugin does not track prompts that use Amp on another computer, [Amp for Web](https://ampcode.com), or Amp on your phone. 

This variant of the plugin automatically record when the thread started and ended, and will automatically connect with the helios server.

To utilise this plugin, you may either start a new Amp thread, or, run `plugins:reload` in a pre-existing thread.


<a id="amp-cloud"></a>
## Cloud Threads

Threads that are started in the Amp app or on Amp for Web ([ampcode.com](ampcode.com)) run on Orbs, which the previous plugin cannot read from. A secondary plugin, [`helios-cloud.ts`](https://github.com/part-avocado/helios/blob/main/amp/helios-cloud.ts), is able to access the information. This plugin is loaded onto your cloud threads, allowing ease of use anywhere.

### Installation

1. Go to [Setup](https://helios.partavocado.cc/settings.html), and select "Be agentic".
2. On that page, open **Amp cloud threads** and choose **Make a key for Amp cloud**. Copy the key: it shows once.
3. Copy the prompt under the key and paste it into any Amp thread.
4. When Amp asks for the value of `HELIOS_KEY`, paste the key. Amp asks in a private box, so the key stays out of the thread.

[This link](../site/settings.html#amp-cloud) opens **Amp cloud threads** directly. No computer needs to be on, and you don't need helios installed anywhere.

### What the key is

The key is a sync key. It works like a password that lets Amp send your hours to your site. It can send them, but it can't read your stats.

- Settings, Setup lists it under Sync keys as “Cloud sessions”.
- Making a new one stops the old one working. Give Amp the new one, as the value of `HELIOS_KEY`.
- To stop counting cloud threads, revoke it there.

### What Amp ends up with

The prompt asks Amp to add three things to your own Amp settings. If you would rather add them by hand, these are all there is:

| What | Where in Amp | Value |
| --- | --- | --- |
| `helios-cloud.ts` | Your personal plugins | [The file](https://github.com/part-avocado/helios/blob/main/amp/helios-cloud.ts), as it is. |
| `HELIOS_SERVER` | Secrets & Env Vars, as an environment variable | Your site's address, such as `https://helios.partavocado.cc`. |
| `HELIOS_KEY` | Secrets & Env Vars, as a secret | The key. |

<a id="amp-cloud-check"></a>
### Check that it works

1. Start a new thread in the Amp app or on ampcode.com, send a prompt, and wait for Amp to finish.
2. Reload [Settings](../site/settings.html). Under Setup, Sync keys, the “Cloud sessions” key now says when it was last used. Under Computers there is an entry named “Cloud sessions”, and your dashboard has the time.

If that isn't what you see:

| What you see | What it means, and what to do |
| --- | --- |
| The key says “never used”. | Amp isn't running the plugin, or the plugin has no key. Check that all three things in the table above are there, with those exact names, then start a new thread. When a value is missing, the plugin does nothing but log `helios: not counting this cloud thread`. |
| The key was used, but Computers has no “Cloud sessions”. | Time is counted when Amp finishes a turn or you stop it, so wait for the turn to end. A new thread also has to download helios first, which can delay its first prompt's record. |
| It worked, and then stopped. | The key was replaced or revoked. Make a new one under **Amp cloud threads** and set it as `HELIOS_KEY` in Amp. |
| A thread on your own computer isn't counted. | This plugin only runs in Amp's cloud. Threads on your computer need the first plugin: run `helios setup amp`. |

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

Setup on the site can hand the work to your agent. On the dashboard before your first sync, or under Settings, Setup, choose **Start setup** (**Add a computer** once you have one), then **Let your agent do it**. It shows a prompt to paste into Claude Code, Codex, or Amp, with your server already filled in. The agent then:

1. installs helios;
2. runs `helios setup -yes`, to add the hooks and the plugin without stopping to ask;
3. runs `helios login` and shows you a code, which you type on the setup's last step;
4. shows you the result.

`-yes` is what lets an agent finish setup, since setup otherwise asks before changing any settings and an agent can't answer. The prompt holds no key, so nothing secret ends up in that thread.
