package main

// Every message, prompt, heading, and help line the helios command shows a
// person lives here, grouped by command, so the wording can be changed in one
// place without reading the code that prints it.
//
// Most are format strings: keep each %s, %d, %q, %v, and %w, in the same
// order, when rewording one. A message that ends in \n is printed as is; one
// without is joined into a longer line, or returned as an error. Text that is
// also data, such as hook commands, file names, and what the site reads, is
// not here: changing it would break setups, not reword them.

// Shared across commands.
const (
	txtErrPrefix = "helios:" // before an error that stops a command

	// Flag help shared by several commands.
	txtFlagClaudeDirs = "Claude Code config directories, comma-separated"
	txtFlagCodexDirs  = "Codex home directories, comma-separated"
	txtFlagNoOpen     = "don't open a browser"

	// Nouns passed to plural, which adds an s for any count but 1.
	txtNounSession   = "session"
	txtNounProject   = "project"
	txtNounPrompt    = "prompt"
	txtNounLogFile   = "log file"
	txtNounEvent     = "event"
	txtNounRecord    = "record"
	txtNounProblem   = "problem"
	txtNounMinute    = "minute"
	txtNounOlderLine = "older line"

	// Durations, counts, and times.
	txtMinutes      = "%dm"
	txtHoursMinutes = "%dh%02dm"
	txtAgoMinutes   = "%dm ago"
	txtAgoHours     = "%dh ago"
	txtAgoDays      = "%dd ago"
	txtMillions     = "%.1fM"
	txtThousands    = "%.1fk"
	txtKilobytes    = "%.1f kB"
	txtMegabytes    = "%.1f MB"
	txtNone         = "-" // an empty cell in a table
	txtDayFormat    = "Mon Jan 2"
	txtTimeFormat   = "15:04"

	// The tool table that setup prints.
	txtStatusOK                 = "ok: %s, newest %s"
	txtStatusNotInstalled       = "not installed here"
	txtStatusInstalledNoSession = "installed, no sessions yet"
	txtStatusPluginAdded        = "plugin added, no sessions yet"
	txtStatusPluginNotAdded     = "installed, plugin not added"
	txtStatusHooksAdded         = "hooks added, no sessions yet"
	txtStatusHooksNotAdded      = "installed, hooks not added"
	txtStatusAmpAppOnly         = "app only, threads run in the cloud"

	// Said while setting up or removing hooks and plugins.
	txtNoTerminal          = "\n  (no terminal to ask on; rerun with -yes to apply)\n"
	txtSkipped             = "Skipped.\n"
	txtSkippedRerun        = "  Skipped. Run `helios setup` again to change your mind.\n"
	txtDone                = "Done.\n"
	txtCouldNotUpdate      = "  Could not update %s: %v\n"
	txtCouldNotWrite       = "  Could not write %s: %v\n"
	txtCouldNotWriteNL     = "\n  Could not write %s: %v\n"
	txtCouldNotRemove      = "\n  Could not remove %s: %v\n"
	txtRemovedHooksFrom    = "Removed helios hooks from %s\n"
	txtRemovedHooksFromNL  = "\n  Removed helios hooks from %s\n"
	txtUpdatedHookPath     = "\n  Updated the helios hook path in %s\n"
	txtNotOurs             = "\n  %s exists but was not written by helios, so it was left alone.\n"
	txtCreatesConfirm      = "  This creates %s [Y/n] "
	txtEditsConfirm        = "  This edits %s [Y/n] "
	txtNotJSON             = "it is not valid JSON"
	txtUnknownShape        = "it has a shape helios doesn't recognize"
	txtUnknownHooksShape   = `its "hooks" have a shape helios doesn't recognize`
	txtUnknownHooksSetting = `its "hooks" setting has a shape helios doesn't recognize`
	txtGoRun               = "helios is running from `go run`; install it first"

	// Talking to the site.
	txtServerSaidPrefix = "server said "
	txtServerSaid       = txtServerSaidPrefix + "%s: %s"
	txtServerUnreadable = "server sent an answer helios can't read: %w"
	txtCouldNotReach    = "could not reach %s: %w"
	txtSiteAnswered     = "the site answered %s"
	txtNoSiteTime       = "the site did not say its time"
)

// helios, the timeline (main.go).
const (
	// The commands people run. hook and relay are left out: tools run them,
	// and the docs cover them.
	txtUsage = `Usage: helios [flags]            show your AI coding timeline (-l keeps it updating live)
       helios setup              check which tools are found, install hooks, fix settings that lose history
       helios setup amp          set up one tool only: claude, codex, amp, opencode, copilot, or cursor
       helios dashboard          open a live dashboard of your stats in the browser
       helios calibrate          show how the time model's caps treat your logs; uploads nothing
       helios export             write a signed report to upload on the website, under Settings
       helios login -server URL  connect this computer to your account on your helios site
       helios sync               upload your signed counts (time, prompts, tokens, lines; no text) to your account on the website
       helios status             show whether this computer is set up and sending
       helios doctor             check everything that decides whether your time counts, and say how to fix it
       helios update             download the latest helios and replace this one with it
       helios uninstall          remove helios's hooks, plugin, and PATH line, then this binary

`
	txtFlagClaudeDirsDefault = "Claude Code config directories, comma-separated (default: $CLAUDE_CONFIG_DIR, ~/.claude, ~/.config/claude)"
	txtFlagCodexDirsDefault  = "Codex home directories, comma-separated (default: $CODEX_HOME, ~/.codex)"
	txtFlagSince             = "only count events newer than this, such as 24h, 7d, or 30d"
	txtFlagJSON              = "print the report as JSON"
	txtFlagVerbose           = "list log files that could not be read"
	txtFlagLive              = "keep the timeline on screen and update it as you work (also -l)"
	txtFlagLiveShort         = "short for -live"
	txtFlagEvery             = "with -live, how often to reread the logs"
	txtFlagVersion           = "print the version and exit"

	txtUnknownCommand    = "helios: unknown command %q\n\n"
	txtVersion           = "helios %s\n"
	txtLiveNoJSON        = "-live redraws the screen, so it can't be combined with -json"
	txtBadSince          = "-since %q: use a length such as 24h, 7d, or 30d"
	txtLastBackgroundErr = "\nThe last background %s failed %s. Run `helios doctor` to see why.\n"
	txtSkippedLogs       = "helios: skipped %s that could not be read (-verbose lists them)\n"

	txtEmptyWindow    = "No Claude Code, Codex, or Amp sessions found in the last %s.\n"
	txtEmptyNoLogs    = "Run `helios setup` to see where helios looks for them.\n"
	txtEmptyTryLonger = "Try a longer window, such as `helios -since 30d`.\n"

	txtBarAnalyzing = "Analyzing sessions"
	txtBarSessions  = "sessions"

	txtBlocksHeader     = "WHEN\tPROJECT\tENGAGED\tSPAN\tPROMPTS\tTOKENS IN/OUT\tTOOLS"
	txtProjectsHeader   = "PROJECT\tENGAGED\tSESSION TIME\tPROMPTS\tSKIPPED\tTOKENS IN/OUT\tAGENT LINES +/-\tKEPT\tCOMMITTED"
	txtTotalEngaged     = "\nTotal engaged: %s across %s and %s\n"
	txtSkippedPrompts   = "%s earned no time (SKIPPED):\n"
	txtSkippedNoise     = "  %d read as keyboard mashing rather than writing\n"
	txtSkippedRepeat    = "  %d asked again for something already asked twice in the last 5 prompts\n"
	txtSkippedAutopilot = "  %d only steered (\"continue\", \"yes\", \"fix it\") after two such prompts in a row\n"
)

// helios -live (live.go).
const (
	txtLiveHead       = "helios live - last %s - updated %s - every %s - Ctrl-C to quit"
	txtLiveTimeFormat = "15:04:05"
	txtLiveIdle       = "idle"
	txtLiveActive     = "active"
	txtLiveAgo        = "%s ago"
	txtLiveJustNow    = "just now"
	txtLiveStatus     = "%s in %s, last activity %s"
	txtLiveSkipped    = "skipped %s that could not be read (helios -verbose lists them)"
	txtLiveHidden     = "  … %s hidden; make the window taller or use a shorter -since"
)

// helios setup (setup.go, adapters.go, amp.go, opencode.go, antigravity.go, hooks.go).
const (
	txtSetupUsage = "Usage: helios setup [flags] [claude] [codex] [amp] [opencode] [antigravity] [copilot] [cursor]\n" +
		"       Sets up every tool it finds, or only the ones you name.\n" +
		"       helios setup [claude] [codex] [antigravity] [opencode] -project\n" +
		"       Sets up cloud sessions of the repository you are in: Claude Code on the web,\n" +
		"       Codex cloud, and Antigravity or OpenCode on a remote machine.\n" +
		"\n"
	txtFlagYes         = "apply recommended changes without asking"
	txtFlagRemoveHooks = "remove helios's hooks and its Amp and OpenCode plugins, keeping helios installed (helios uninstall removes everything)"
	txtFlagProject     = "put hooks in the repository you are in, to commit, so its cloud sessions record time (claude, codex, antigravity, opencode; all four if none is named)"

	txtSetupErrPrefix    = "helios setup:"
	txtSetupUnknownTool  = "unknown tool %q; use claude, codex, amp, opencode, antigravity, copilot, or cursor"
	txtSetupProjectOnly  = "helios setup: -project is for Claude Code, Codex, Antigravity, and OpenCode, not %s\n"
	txtSetupLooking      = "Looking for AI coding tools on this machine...\n\n"
	txtSetupUnreadable   = "\n  %s could not be read and will be skipped (run `helios -verbose` to list them).\n"
	txtSetupJournal      = "\n  Hook journal: %s from %s in %s\n"
	txtSetupNoGit        = "\n  Note: git is not installed, so projects are grouped by folder instead of by repository.\n"
	txtSetupNoOpenCode   = "OpenCode was not found on this machine. If its config is in a custom place, set OPENCODE_CONFIG_DIR.\n"
	txtSetupNoAntigrav   = "Antigravity was not found on this machine; it keeps its settings in %s.\n"
	txtSetupToolNotFound = "%s was not found on this machine. If its logs are in a custom place, pass -%s-dir.\n"
	txtSetupNoTools      = "No supported tools found. helios reads Claude Code and Codex logs, and\n" +
		"records Amp, OpenCode, Copilot, and Cursor through plugins and hooks. If yours keep logs in a custom place, pass\n" +
		"-claude-dir or -codex-dir.\n"
	txtSetupDoneRemoved = "Done. You can now delete the helios binary.\n"
	txtSetupDone        = "Done. Nothing needs to stay running. Run `helios` any time to see your timeline.\n"

	// Claude Code's transcript retention.
	txtRetentionUnreadable = "\n  Could not read %s (%v).\n  To keep Claude Code history, set \"cleanupPeriodDays\": %d in it by hand.\n"
	txtRetentionAsk        = "\n  Claude Code deletes transcripts after %d days, so older work would disappear\n" +
		"  from your stats. Keep them for %d days instead? This edits %s\n"
	txtRetentionConfirm = "  (a backup is saved next to it) [Y/n] "
	txtRetentionFailed  = "  Could not update it: %v\n"
	txtRetentionUpdated = "  Updated.\n"

	// Claude Code hooks.
	txtClaudeUnreadable  = "\n  Could not read %s (%v), so Claude Code hooks were not set up.\n"
	txtClaudeSkipped     = "\n  Skipped Claude Code hooks: %v.\n"
	txtClaudeSetupFailed = "\n  Could not set up Claude Code hooks in %s: %v\n"
	txtClaudeInstalled   = "\n  Claude Code hooks: installed (%s)\n"
	txtClaudeAsk         = "\n  Add helios hooks to Claude Code? When you send a prompt or Claude finishes,\n" +
		"  they record the time and folder (never the prompt text) in %s,\n" +
		"  so your history is kept even if Claude Code deletes its transcripts.\n"
	txtClaudeAdded = "  Added. New Claude Code sessions will use them.\n"

	// Codex hooks and notify.
	txtCodexUnreadable   = "\n  Could not read %s (%v), so Codex hooks were not set up.\n"
	txtCodexSkipped      = "\n  Skipped Codex hooks: %v.\n"
	txtCodexSetupFailed  = "\n  Could not set up Codex hooks in %s: %v\n"
	txtCodexConfirm      = "\n  Add helios hooks to Codex, so each prompt is recorded as it happens? This edits %s [Y/n] "
	txtCodexAdded        = "  Added. Open Codex, run /hooks, and trust helios's hooks: Codex skips new hooks until you do.\n"
	txtCodexInstalled    = "\n  Codex hooks: installed (%s). If Codex hasn't run them yet, trust them in /hooks.\n"
	txtCodexNotifyAdded  = "  Codex now starts a helios sync when a turn ends (notify in %s).\n"
	txtCodexNotifyTheirs = "Your Codex config.toml already has a notify program, so helios left it alone; trust helios's hooks in /hooks instead."

	// Cursor and Copilot hooks.
	txtCursorSetupFailed = "\n  Could not set up Cursor hooks in %s: %v\n"
	txtCursorInstalled   = "\n  Cursor hooks: installed (%s)\n"
	txtCursorConfirm     = "\n  Add helios hooks to Cursor? This edits %s [Y/n] "
	txtCursorAdded       = "  Added. Restart Cursor to load them.\n"
	txtCopilotRemoved    = "\n  Removed helios hooks from Copilot (%s)\n"
	txtCopilotInstalled  = "\n  Copilot hooks: installed (%s)\n"
	txtCopilotConfirm    = "\n  Add helios hooks to GitHub Copilot? This writes %s [Y/n] "
	txtCopilotAdded      = "  Added. New Copilot sessions will use them.\n"

	// Antigravity hooks.
	txtAntigravSkipped     = "\n  Skipped Antigravity hooks: %v.\n"
	txtAntigravSetupFailed = "\n  Could not set up Antigravity hooks in %s: %v\n"
	txtAntigravInstalled   = "\n  Antigravity hooks: installed (%s)\n"
	txtAntigravConfirm     = "\n  Add helios hooks to Antigravity, so each prompt is recorded as it happens? This edits %s [Y/n] "
	txtAntigravAdded       = "  Added. New Antigravity conversations will use them; check under Customizations, Hooks.\n"

	// The Amp plugin.
	txtAmpAppOnly = "\n  The Amp app is installed (%s), but no thread runs on this computer yet.\n" +
		"  The app's threads run in Amp's cloud, which helios can't see from here.\n" +
		"  To count them, add helios's cloud plugin to Amp: your helios site has\n" +
		"  the steps under Settings, Setup, Amp. That time is counted in the cloud\n" +
		"  and shows up on your dashboard without this computer.\n" +
		"  Or run your threads on this Mac: in the app, open App Settings, Runner,\n" +
		"  and turn it on. That installs the Amp CLI, which loads helios's plugin.\n" +
		"  Then pick \"This Mac\" when you start a thread.\n"
	txtAmpRemoved   = "\n  Removed the helios Amp plugin (%s)\n"
	txtAmpSkipped   = "\n  Skipped the Amp plugin: %v.\n"
	txtAmpInstalled = "\n  Amp plugin: installed (%s)\n"
	txtAmpNotFound  = "\n  Amp was not found on this machine. The plugin can be added anyway, and\n" +
		"  Amp loads it once installed.\n"
	txtAmpAsk = "\n  Add a helios plugin to Amp? When you send a prompt or Amp finishes, it\n" +
		"  records the time and folder (never the prompt text) in helios's journal.\n"
	txtAmpUpdated = "\n  Updated the helios Amp plugin (%s)\n"
	txtAmpAdded   = "  Added. New Amp threads load it; in open ones, run `plugins: reload`.\n"

	// The OpenCode plugin.
	txtOpenCodeRemoved   = "\n  Removed the helios OpenCode plugin (%s)\n"
	txtOpenCodeSkipped   = "\n  Skipped the OpenCode plugin: %v.\n"
	txtOpenCodeInstalled = "\n  OpenCode plugin: installed (%s)\n"
	txtOpenCodeAsk       = "\n  Add a helios plugin to OpenCode? When you send a prompt or a turn ends, it\n" +
		"  records the time and folder (never the prompt text) in helios's journal.\n" +
		"  OpenCode's past sessions can't be read, so time counts from now on.\n"
	txtOpenCodeSkippedRerun = "  Skipped. Run `helios setup opencode` to change your mind.\n"
	txtOpenCodeUpdated      = "\n  Updated the helios OpenCode plugin (%s)\n"
	txtOpenCodeAdded        = "  Added. OpenCode loads it on its own; restart OpenCode if it doesn't.\n"
)

// helios setup -project (setup.go, projectsetup.go).
const (
	txtNotInRepoClaude  = "this folder is not in a git repository; run `helios setup claude -project` inside the one to set up"
	txtNotInRepo        = "this folder is not in a git repository; run `helios setup -project` inside the one to set up"
	txtProjectOnlyFor   = "-project is for Claude Code, Codex, Antigravity, and OpenCode"
	txtCouldNotRead     = "could not read %s: %v"
	txtCouldNotSetUpIn  = "could not set up hooks in %s: %v"
	txtCouldNotSetUp    = "could not set up %s: %v"
	txtProjectNoHooks   = "%s has no helios hooks.\n"
	txtProjectClaudeOK  = "Claude Code project hooks: installed (%s)\n"
	txtProjectToolOK    = "%s project hooks: installed (%s)\n"
	txtProjectClaudeAsk = "Add helios hooks to this repository's Claude Code settings? In a session where\n" +
		"HELIOS_KEY is set, such as a cloud environment with your secrets, they install\n" +
		"helios if it is missing and record time. Everywhere else they do nothing.\n"
	txtProjectEditsConfirm = "This edits %s [Y/n] "
	txtProjectToolConfirm  = "Add helios's %s hooks to this repository? On a cloud machine with HELIOS_KEY set they record time; elsewhere they do nothing. This writes %s [Y/n] "
	txtProjectClaudeAdded  = "Added to %s. Commit it, and add HELIOS_SERVER and HELIOS_KEY as secrets\n" +
		"of the cloud environment. Where your own Claude Code settings already have helios's\n" +
		"hooks, these do nothing, so each event is recorded once.\n"
	txtProjectToolAdded = "Added to %s. Commit it.\n"
)

// helios hook (hooks.go). Only -check prints these; a hook run by a tool stays quiet.
const (
	txtHookPrefix      = "helios hook:"
	txtHookBadTool     = "helios hook: %q is not a tool name; use lowercase letters, digits, and dashes\n"
	txtHookNotJSON     = "helios hook: stdin is not a JSON object\n"
	txtHookNotRecorded = "helios hook: not recorded: it needs a session_id and an event that is one of prompt, turn_end, session_start, session_end, or edit\n"
	txtHookCheck       = "kind: %s\nrecord: %s\n"
	txtHookCheckStdout = "stdout: %s\n"
)

// helios dashboard (dashboard.go).
const (
	txtFlagAddr          = "address to listen on (localhost only)"
	txtDashboardNotLocal = "-addr %s: the dashboard only listens on localhost, so your stats stay on this machine"
	txtDashboardURL      = "helios dashboard: %s\n"
	txtDashboardUpdates  = "It updates every 30 seconds. Press Ctrl+C to stop.\n"
	txtForbidden         = "forbidden"
	txtOpenLinkYourself  = "Open the link above in your browser.\n"
)

// helios calibrate (calibrate.go).
const (
	txtFlagCalibrateSince = "only read events newer than this"
	txtCalibrateSessions  = "%s. Nothing was uploaded.\n\n"
	txtCalibrateHeader    = "Gap before\tcount\tmedian\t75%\t90%\tover cap\t"
	txtCalibrateGapPrompt = "a prompt"
	txtCalibrateGapAgent  = "agent output"
	txtCalibrateGrid      = "\nEngaged total by compose cap (rows) and watch cap (columns); * marks the caps in use:\n"
	txtCalibrateInUse     = "*"
)

// helios export (export.go).
const (
	txtFlagExportSince   = "only count events newer than this, such as 30d or 365d"
	txtFlagOut           = "write to this file instead of standard output"
	txtExportSigned      = "Signed by account %s. The key is valid until %s; upload it on the website, under Settings, before then.\n"
	txtExportUntilFormat = "Mon Jan 2 15:04"
	txtKeyDamaged        = "%s is damaged; delete it to make a new account key"
	txtNotSigned         = "not a signed helios file"
	txtSignatureMismatch = "the key does not match the contents; it was changed after it was signed"
	txtSignedInFuture    = "it says it was made in the future; check the clock"
	txtSignedExpired     = "its key expired on %s"
	txtSignedTooLong     = "its key is valid for longer than helios allows"
)

// helios login (login.go).
const (
	txtLoginUsage = "Usage: helios login -server https://your-site\n" +
		"       Connects this computer to your account: type the code it shows on the site.\n" +
		"\n"
	txtFlagLoginServer = "your helios site, such as https://helios.example.org, remembered for later runs"
	txtLoginNameSite   = "name your helios site: helios login -server https://your-site\n" +
		"Your site's dashboard, or Settings, Setup, shows the exact command, ready to copy"
	txtLoginConnected = "Connected to %s's account on %s.\n\n"
	txtLoginEnvKey    = "HELIOS_KEY is set in this environment, and is used in place of the key this login saved. Unset it, or replace it with a sync key from the site's Settings page, then run `helios sync`"
	txtLoginDoctorTip = "\nRun `helios doctor` any time to check that your time is reaching the site.\n"
	txtLoginNoLogin   = "%s has no `helios login` yet; copy the command under Settings, Setup on it instead"
	txtLoginBadPage   = "%s answered with a page that isn't its own (%q)"
	txtLoginPrompt    = "To connect this computer (%s) to your account, open\n\n    %s\n\nand type this code:\n\n    %s\n\nWaiting for you to allow it there... (Ctrl+C to stop)\n\n"
	txtLoginBadKey    = "%s sent a key helios doesn't recognize"
	txtLoginDenied    = "not connected: it was cancelled on the site"
	txtLoginExpired   = "not connected: the code expired before it was allowed. Run `helios login` again"
)

// helios sync (sync.go, records.go).
const (
	txtFlagSyncServer = "central server URL, remembered for later runs"
	txtFlagSyncKey    = "your sync key from the server's Settings page, remembered for later runs"
	txtFlagQuiet      = "print only errors (used by hooks)"
	txtFlagBackground = "do nothing while another background sync runs, and sync again if a turn ended meanwhile (used by hooks)"
	txtFlagDryRun     = "print the records a sync would send, as JSON lines, and send nothing"

	txtBadServer     = "-server %q: use a URL such as https://helios.example.org"
	txtNoServer      = "no server set; run `helios login -server https://your-site` once"
	txtSyncBusy      = "another sync is running"
	txtDryRunSummary = "A sync would send %s. Nothing was sent.\n"
	txtSyncSent      = "Sent %s from this computer (%s); %d were new to the site.\n"
	txtSyncFuture    = "The site refused %s dated more than 5 minutes ahead of its clock.\n"
	txtSeeDashboard  = "See it at %s/dashboard\n"

	// What a clock that is off does to the person's time.
	txtClockAhead     = "ahead of"
	txtClockBehind    = "behind"
	txtClockSmallSkew = "Your clock is %s %s the site's. The site corrects this computer's records by the offset it measured when they first arrived; if your clock changes, it takes a day to follow, and records sent meanwhile may not count. An older site doesn't correct at all. Set your clock to update automatically."
	txtClockFarAhead  = "Your clock is %s ahead of the site's. The site corrects a computer's clock by 5 minutes at most, and refuses records that are still dated more than 5 minutes ahead of it, so that time doesn't count. Set your clock to update automatically."
	txtClockFarBehind = "Your clock is %s behind the site's. The site corrects a computer's clock by 5 minutes at most; past that, your records look like they arrived late, so the site keeps them but may credit none of their time. Set your clock to update automatically."
)

// helios relay (relay.go, cloud.go).
const (
	txtFlagCount        = "then count your cloud threads and sync the result"
	txtFlagRelayVerbose = "say what was sent, or why nothing was"
	txtRelayNoKey       = "no sync key set; put yours in $HELIOS_KEY"
	txtRelaySent        = "Sent.\n"
	txtRelayFuture      = "The site refused %s dated more than 5 minutes ahead of its clock. Run `helios sync` to compare clocks.\n"
	txtRelayCounted     = "Counted your cloud threads and synced them.\n"
	txtNoCloudKey       = "the server sent no key to sign cloud threads with"
)

// helios doctor and helios status (doctor.go).
const (
	txtStatusNeedsFix = "\nSomething needs fixing. Run `helios doctor` to see how.\n"
	txtDoctorMarkOK   = "ok"
	txtDoctorMarkNote = "note"
	txtDoctorMarkFix  = "FIX"
	txtDoctorNothing  = "Nothing needs fixing.\n"
	txtDoctorToFix    = "%s to fix.\n"
	txtAnd            = " and "
	txtIsNot          = "is not"
	txtAreNot         = "are not"

	// What each check is called.
	txtCheckHelios  = "helios"
	txtCheckUpdate    = "Update"
	txtCheckCloud     = "Cloud mode"
	txtCheckSite      = "Site"
	txtCheckClock     = "Clock"
	txtCheckOutbox    = "Outbox"
	txtCheckWaiting   = "Waiting"
	txtCheckLastSync  = "Last sync"
	txtCheckLastError = "Last error"
	txtCheckClaude    = "Claude Code hooks"
	txtCheckCodex     = "Codex hooks"
	txtCheckNotify    = "Codex notify"
	txtCheckCursor    = "Cursor hooks"
	txtCheckCopilot   = "Copilot hooks"
	txtCheckAmp       = "Amp plugin"
	txtCheckOpenCode  = "OpenCode plugin"

	// What each check found, and what to do about it.
	txtHeliosNoPath    = "%s (%v)"
	txtHeliosFixPath   = "Install it with the installer, so hooks have a fixed path to run."
	txtHeliosAt        = "%s at %s"
	txtUpdateOut         = "%s is out"
	txtUpdateFix         = "Run `helios update`."
	txtUpdateFixAuto     = "Auto-update is on: the next background sync installs it, or run `helios update` now."
	txtUpdateLatestAuto  = "this is the latest release; auto-update is on"
	txtUpdateLatest      = "this is the latest release"
	txtCloudOn           = "on, since %s is set: hooks send each event straight to the site, as the computer \"cloud\""
	txtCloudOff          = "off: %s is set, but %s %s"
	txtCloudOffFix       = "Add %s as a secret of this environment, and its hooks send time to your site without a sign-in. Without, this machine is counted as a computer of its own."
	txtSiteNoKey         = "%s is set, but no sync key"
	txtSiteNoKeyCloud    = "Add HELIOS_KEY, a sync key from the site's Settings page, as a secret of this environment."
	txtSiteFixLogin      = "Run `helios login -server %s`."
	txtSiteSignedIn      = "signed in as %s (@%s) on %s"
	txtClockMatches      = "matches the site's"
	txtSiteBadEnvKey     = "%s does not know the sync key in HELIOS_KEY"
	txtSiteBadEnvKeyFix  = "Replace HELIOS_KEY with a sync key from the site's Settings page, or unset it and run `helios login -server %s`."
	txtSiteBadKey        = "%s does not know this computer's sync key"
	txtSiteBadKeyFix     = "Run `helios login -server %s` to connect it again."
	txtSiteOld           = "%s is older than this helios, so the account and clock were not checked"
	txtSiteUnreachable   = "could not reach %s: %s"
	txtSiteUnreachFix    = "Check your connection, then run `helios doctor` again."
	txtOutboxFull        = "full, so new records are not being kept"
	txtOutboxFullFix     = "Run `helios relay -verbose` to send what is waiting and see why it couldn't."
	txtWaitingRecords    = "%s not sent yet"
	txtWaitingFix        = "Run `helios relay -verbose` to send them now and see any error."
	txtWaitingNothing    = "nothing"
	txtLastSyncNever     = "never"
	txtLastSyncFix       = "Run `helios sync`."
	txtLastErrorFailed   = "%s failed %s: %s"
	txtLastErrorFix      = "Run `%s` to see whether it still fails."
	txtCodexUntrusted    = "installed, but Codex has not run them in two weeks of Codex sessions"
	txtCodexUntrustedFix = "Open Codex, run /hooks, and trust helios's hooks. Until then, prompts are counted late."
	txtPluginOld         = "from an older helios"
	txtHookFixSetup      = "Run `helios setup %s`."
	txtHookMissing       = "not installed, so prompts are counted late or not at all"
	txtHookGone          = "run %s, which is no longer there, so nothing is recorded"
	txtHookOther         = "run another helios, at %s"
	txtHookOtherFix      = "Run `helios setup %s` with the helios you use."
	txtHookInstalled     = "installed"
)

// helios update (update.go).
const (
	txtUpdateUsage = "Usage: helios update [-check] [version]\n" +
		"       helios update -auto on|off\n" +
		"       Downloads the latest helios, checks it, replaces this one with it,\n" +
		"       and runs `helios setup` with the new version. Name a version, such\n" +
		"       as v0.5.0, to install that one instead, even if it is older.\n" +
		"\n"
	txtFlagCheck = "only say whether a newer version is out"
	txtFlagAuto  = "on: install each new release by itself, in the daily background check; off: only say one is out"

	txtAutoOn          = "helios now installs each new release by itself, once a day, after checking its checksum and that it runs. The one it replaces is kept beside it, ending in .old. `helios update -auto off` stops this.\n"
	txtAutoOff         = "helios now only says when a new release is out. Run `helios update` to install one.\n"
	txtAutoBad         = "-auto takes on or off, not %q"
	txtUpdateNoPath    = "%v, and then `helios update` keeps it current"
	txtUpdateSetupErr  = "helios is updated, but its setup did not finish. Run `helios setup` to try again.\n"
	txtUpdateIsLatest  = "helios %s is the latest version."
	txtUpdateIsOut     = "helios %s is out; you have %s. Run `helios update` to install it."
	txtUpdateBadPick   = "%q is not a version; name one such as v0.5.0"
	txtUpdateHavePick  = "helios %s is already installed."
	txtUpdateNoRelease = "there is no helios release %s. They are listed at %s"
	txtUpdateNoReplace = "could not replace %s: %w. If helios was installed with admin rights, update it the same way"
	txtUpdateInstalled = "Installed helios %s in place of %s (%s)."
	txtUpdateUpdated   = "Updated helios from %s to %s (%s)."
	txtNoSuchRelease   = "no such release"
	txtLatestFailed    = "could not look up the latest version: %w"
	txtLatestAnswered  = "could not look up the latest version: %s answered %s"
	txtLatestNone      = "could not look up the latest version: %s has no release yet"
	txtSumsFailed      = "could not download %s/checksums.txt: the server answered %d"
	txtNoAsset         = "this release has no helios for %s/%s"
	txtAssetFailed     = "could not download %s/%s: the server answered %d"
	txtChecksumBad     = "the download is corrupted (checksum mismatch). Nothing was changed; try again"
	txtDownloadFailed  = "could not download %s: %w"
	txtDownloadTooBig  = "could not download %s: it is larger than expected"
	txtBarDownloading  = "Downloading"
	txtAutoUpdateErr   = "could not update to %s by itself: %w"
	txtTryTimedOut     = "it did not finish in 30 seconds"
	txtTryFailed       = "the downloaded helios did not run as %s (%v, said %q); nothing was changed"
	txtSelfUpdated     = "helios updated itself from %s to %s. Run `helios setup` to bring hooks and plugins up to date. The one before is kept beside it, ending in .old."
	txtUpdateNotice    = "helios %s is out (this is %s). Run `helios update`."
)

// helios uninstall (uninstall.go).
const (
	txtUninstallUsage = "Usage: helios uninstall [-yes] [-keep-data]\n" +
		"       Removes helios's hooks, Amp plugin, PATH entry, and this binary.\n" +
		"\n"
	txtFlagUninstallYes = "don't ask; also deletes the data folder unless -keep-data is set"
	txtFlagKeepData     = "keep helios's data folder"

	txtUninstallIntro = "This removes helios's hooks from Claude Code, Codex, Antigravity, Cursor, and Copilot,\n" +
		"its Amp and OpenCode plugins, and the PATH line the installer added.\n"
	txtUninstallThenDelete = "Then it deletes %s.\n"
	txtUninstallWaiting    = "\n%s not sent to your site yet. To send them first, stop here and run\n" +
		"`helios relay -verbose` and `helios sync`.\n"
	txtUninstallConfirm   = "Uninstall helios? [Y/n] "
	txtUninstallUnchanged = "Nothing was changed.\n"
	txtProfileEditFailed  = "\n  Could not edit %s: %v. Delete the lines under %q in it.\n"
	txtProfileRemoved     = "\n  Removed the installer's PATH line from %s\n"
	txtProfileNotFound    = "\n  Found no installer PATH line for %s in your shell's startup files. If you added one, delete it.\n"
	txtKeepDataAsk        = "\nKeep helios's data folder, %s?\n" +
		"It holds the hook journal and this computer's account key, which names it on your site.\n"
	txtKeepDataConfirm   = "Keep it if you may install helios here again. [Y/n] "
	txtDataKept          = "\n  Kept %s\n"
	txtDataDeleteFailed  = "\n  Could not delete %s: %v\n"
	txtDataDeleted       = "\n  Deleted %s\n"
	txtUninstallNoBinary = "Done. Delete the helios binary yourself (%v).\n"
	txtUninstallDone     = "Done. helios is uninstalled.\n"
	txtUninstallWindows  = "Done. Delete %s once this window closes; Windows can't delete a program while it runs.\n"
	txtUninstallOutro    = "Your account on the site keeps what it has; remove this computer under Settings,\n" +
		"Computers. Claude Code's longer history setting and helios's settings backups\n" +
		"(*.helios-backup) are left as they are.\n"
	txtWinPathFailed  = "\n  Could not edit your Path (%v). Remove %s from it in Settings > Edit environment variables for your account.\n"
	txtWinPathRemoved = "\n  Removed %s from your Path\n"
)
