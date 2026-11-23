package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

// `teardrop doctor` checks what decides whether this computer's time reaches
// the site: this binary, the site and key, the clock, each tool's hooks, what
// is waiting to send, and the last background error. It says how to fix
// each problem and exits 1 when there is one. `teardrop status` prints the
// same checks in brief. Neither writes anything or prints the sync key.

// A finding's level: fine, worth knowing, or losing time until fixed.
const (
	levelOK = iota
	levelNote
	levelFix
)

type finding struct {
	Name   string
	Level  int
	Detail string
	Fix    string // what to run or do, for a note or a fix
}

// lastErrorPrefix names the files that hold each background command's
// last error, as JSON: last-error-sync, last-error-relay, last-error-update.
const lastErrorPrefix = "last-error-"

type lastError struct {
	Time    time.Time `json:"t"`
	Command string    `json:"command"`
	Message string    `json:"message"`
}

// keepError records what a command run in the background ended with: an
// error stays until a later run of the same command succeeds, since nobody
// sees their output. Each command keeps its own, so a relay that works
// doesn't hide a sync that keeps failing.
func keepError(command string, err error) {
	os.Remove(filepath.Join(dataDir(), "last-error")) // one file for all, before v0.10
	path := filepath.Join(dataDir(), lastErrorPrefix+command)
	if err == nil {
		os.Remove(path)
		return
	}
	b, _ := json.Marshal(lastError{time.Now(), command, err.Error()})
	os.WriteFile(path, b, 0o600)
}

// readLastError returns the newest kept error, if there is one.
func readLastError() (lastError, bool) {
	var newest lastError
	found := false
	paths, _ := filepath.Glob(filepath.Join(dataDir(), lastErrorPrefix+"*"))
	for _, p := range paths {
		var e lastError
		if b, err := os.ReadFile(p); err == nil && json.Unmarshal(b, &e) == nil && (!found || e.Time.After(newest.Time)) {
			newest, found = e, true
		}
	}
	return newest, found
}

func runDoctor(args []string) {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	fs.Parse(args)
	if printDoctor(os.Stdout, diagnose(*claudeDir, *codexDir, &http.Client{Timeout: 10 * time.Second}, releasesURL)) {
		os.Exit(1)
	}
}

func runStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	fs.Parse(args)
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	worst := levelOK
	for _, f := range diagnose(*claudeDir, *codexDir, &http.Client{Timeout: 10 * time.Second}, releasesURL) {
		fmt.Fprintf(w, "%s\t%s\n", f.Name, f.Detail)
		worst = max(worst, f.Level)
	}
	w.Flush()
	if worst == levelFix {
		fmt.Println("\nSomething needs fixing. Run `teardrop doctor` to see how.")
	}
}

// printDoctor prints the findings with what to do about each, and reports
// whether any needs fixing.
func printDoctor(out io.Writer, findings []finding) bool {
	marks := []string{"ok", "note", "FIX"}
	fixes := 0
	for _, f := range findings {
		fmt.Fprintf(out, "%-4s  %s: %s\n", marks[f.Level], f.Name, f.Detail)
		if f.Level > levelOK && f.Fix != "" {
			fmt.Fprintf(out, "      %s\n", f.Fix)
		}
		if f.Level == levelFix {
			fixes++
		}
	}
	fmt.Fprintln(out)
	if fixes == 0 {
		fmt.Fprintln(out, "Nothing needs fixing.")
		return false
	}
	fmt.Fprintf(out, "%s to fix.\n", plural(fixes, "problem"))
	return true
}

// diagnose runs every check. releases is where new versions are looked up.
func diagnose(claudeDir, codexDir string, client *http.Client, releases string) []finding {
	var out []finding
	add := func(f finding) { out = append(out, f) }

	exe, exeErr := teardropPath()
	if exeErr != nil {
		add(finding{"teardrop", levelNote, fmt.Sprintf("%s (%v)", version, exeErr), "Install it with the installer, so hooks have a fixed path to run."})
	} else {
		add(finding{"teardrop", levelOK, version + " at " + exe, ""})
	}
	if version != "dev" {
		if latest, err := latestVersion(client, releases); err != nil {
			add(finding{"Update", levelNote, err.Error(), ""})
		} else if newer(latest, version) {
			fix := "Run `teardrop update`."
			if autoUpdateOn() {
				fix = "Auto-update is on: the next background sync installs it, or run `teardrop update` now."
			}
			add(finding{"Update", levelNote, latest + " is out", fix})
		} else if autoUpdateOn() {
			add(finding{"Update", levelOK, "this is the latest release; auto-update is on", ""})
		} else {
			add(finding{"Update", levelOK, "this is the latest release", ""})
		}
	}

	server, err := serverURL("")
	key := ""
	if err == nil {
		key, err = syncKey("", server)
	}
	switch {
	case err != nil:
		add(finding{"Site", levelFix, err.Error(), ""})
	case key == "":
		add(finding{"Site", levelFix, server + " is set, but no sync key", "Run `teardrop login -server " + server + "`."})
	default:
		who, status, err := whoami(client, server, key)
		switch {
		case err == nil:
			add(finding{"Site", levelOK, fmt.Sprintf("signed in as %s (@%s) on %s", who.Name, who.Handle, server), ""})
			if w := clockWarning(who.Skew); w != "" {
				add(finding{"Clock", levelFix, w, ""})
			} else {
				add(finding{"Clock", levelOK, "matches the site's", ""})
			}
		case status == http.StatusUnauthorized:
			add(finding{"Site", levelFix, server + " does not know this computer's sync key", "Run `teardrop login -server " + server + "` to connect it again."})
		case status == http.StatusUpgradeRequired:
			add(finding{"Site", levelFix, strings.TrimPrefix(err.Error(), "server said 426 Upgrade Required: "), "Run `teardrop update`."})
		case status == http.StatusForbidden:
			add(finding{"Site", levelFix, strings.TrimPrefix(err.Error(), "server said 403 Forbidden: "), ""})
		case status == http.StatusNotFound:
			add(finding{"Site", levelNote, server + " is older than this teardrop, so the account and clock were not checked", ""})
		default:
			add(finding{"Site", levelFix, "could not reach " + server + ": " + err.Error(), "Check your connection, then run `teardrop doctor` again."})
		}
	}

	out = append(out, hookFindings(claudeDir, codexDir, exe)...)

	for _, outbox := range []string{localOutbox, relayOutbox} {
		if info, err := os.Stat(filepath.Join(dataDir(), outbox)); err == nil && info.Size() > maxOutboxBytes {
			add(finding{"Outbox", levelFix, "full, so new records are not being kept", "Run `teardrop relay -verbose` to send what is waiting and see why it couldn't."})
		}
	}
	if waiting := waitingRecords(); waiting > 0 {
		add(finding{"Waiting", levelNote, plural(waiting, "record") + " not sent yet", "Run `teardrop relay -verbose` to send them now and see any error."})
	} else {
		add(finding{"Waiting", levelOK, "nothing", ""})
	}
	if server != "" {
		if info, err := os.Stat(filepath.Join(dataDir(), "last-sync")); err != nil {
			add(finding{"Last sync", levelNote, "never", "Run `teardrop sync`."})
		} else if time.Since(info.ModTime()) > 72*time.Hour {
			add(finding{"Last sync", levelNote, ago(info.ModTime()), "Run `teardrop sync`."})
		} else {
			add(finding{"Last sync", levelOK, ago(info.ModTime()), ""})
		}
	}
	if e, ok := readLastError(); ok {
		again := "teardrop sync"
		switch e.Command {
		case "relay":
			again = "teardrop relay -verbose"
		case "update":
			again = "teardrop update"
		}
		add(finding{"Last error", levelFix, fmt.Sprintf("%s failed %s: %s", e.Command, ago(e.Time), e.Message), "Run `" + again + "` to see whether it still fails."})
	}
	return out
}

// waitingRecords counts the records in the outboxes that have not been sent.
func waitingRecords() int {
	n := 0
	for _, pattern := range []string{"local-*.jsonl", "relay-*.jsonl"} {
		files, _ := filepath.Glob(filepath.Join(dataDir(), pattern))
		for _, f := range files {
			b, _ := os.ReadFile(f)
			n += strings.Count(string(b), "\n")
		}
	}
	return n
}

// hookFindings checks the hooks of each tool installed here.
func hookFindings(claudeDir, codexDir, exe string) []finding {
	var out []finding
	for _, loc := range locations(claudeDir, "") {
		if loc.Tool == "Claude Code" && exists(loc.Dir) {
			out = append(out, hookFinding("Claude Code hooks", claudeShapeExes(filepath.Join(loc.Dir, "settings.json"), "claude-code"), exe, "claude"))
		}
	}
	if dir := codexHome(); exists(dir) {
		exes := claudeShapeExes(filepath.Join(dir, "hooks.json"), "codex")
		f := hookFinding("Codex hooks", exes, exe, "codex")
		if f.Level == levelOK && codexUntrusted(codexDir) {
			f = finding{"Codex hooks", levelNote, "installed, but Codex has not run them in two weeks of Codex sessions", "Open Codex, run /hooks, and trust teardrop's hooks. Until then, prompts are counted late."}
		}
		out = append(out, f)
		out = append(out, hookFinding("Codex notify", notifyExes(filepath.Join(dir, "config.toml")), exe, "codex"))
	}
	home, _ := os.UserHomeDir()
	if dir := filepath.Join(home, ".cursor"); exists(dir) {
		out = append(out, hookFinding("Cursor hooks", fileHookExes(filepath.Join(dir, "hooks.json"), "command", "cursor"), exe, "cursor"))
	}
	if dir := filepath.Join(home, ".copilot"); exists(dir) {
		out = append(out, hookFinding("Copilot hooks", fileHookExes(filepath.Join(dir, "hooks", "teardrop.json"), "bash", "copilot"), exe, "copilot"))
	}
	if b, err := os.ReadFile(ampPluginPath()); err == nil || ampInstalled() {
		f := hookFinding("Amp plugin", ampPluginExes(b), exe, "amp")
		if f.Level == levelOK && exe != "" && string(b) != string(renderAmpPlugin(exe)) {
			f = finding{"Amp plugin", levelNote, "from an older teardrop", "Run `teardrop setup amp`."}
		}
		out = append(out, f)
	}
	if b, err := os.ReadFile(openCodePluginPath()); err == nil || openCodeInstalled() {
		f := hookFinding("OpenCode plugin", ampPluginExes(b), exe, "opencode")
		if f.Level == levelOK && exe != "" && string(b) != string(renderOpenCodePlugin(exe)) {
			f = finding{"OpenCode plugin", levelNote, "from an older teardrop", "Run `teardrop setup opencode`."}
		}
		out = append(out, f)
	}
	return out
}

// hookFinding says whether a tool's hooks run this teardrop, given the
// programs they run. exe is "" when this teardrop has no fixed path.
func hookFinding(name string, exes []string, exe, tool string) finding {
	setup := "Run `teardrop setup " + tool + "`."
	if len(exes) == 0 {
		return finding{name, levelFix, "not installed, so prompts are counted late or not at all", setup}
	}
	for _, e := range exes {
		if _, err := os.Stat(filepath.FromSlash(e)); err != nil {
			return finding{name, levelFix, "run " + e + ", which is no longer there, so nothing is recorded", setup}
		}
	}
	for _, e := range exes {
		if exe != "" && e != filepath.ToSlash(exe) {
			return finding{name, levelNote, "run another teardrop, at " + e, "Run `teardrop setup " + tool + "` with the teardrop you use."}
		}
	}
	return finding{name, levelOK, "installed", ""}
}

// commandExe returns the program a hook command runs: the quoted path at its start.
func commandExe(command string) string {
	if rest, ok := strings.CutPrefix(command, `"`); ok {
		exe, _, _ := strings.Cut(rest, `"`)
		return exe
	}
	return ""
}

// claudeShapeExes returns the programs of teardrop's hooks for tool in a
// settings file shaped like Claude Code's.
func claudeShapeExes(path, tool string) []string {
	settings, err := readSettings(path)
	if err != nil {
		return nil
	}
	var hooks map[string][]map[string]json.RawMessage
	json.Unmarshal(settings["hooks"], &hooks)
	var out []string
	for _, groups := range hooks {
		for _, g := range groups {
			var hs []map[string]json.RawMessage
			json.Unmarshal(g["hooks"], &hs)
			for _, h := range hs {
				var c string
				json.Unmarshal(h["command"], &c)
				if ourCommand(c, tool) {
					out = append(out, commandExe(c))
				}
			}
		}
	}
	return out
}

// fileHookExes returns the programs of teardrop's hooks in a Cursor or
// Copilot hooks file, whose commands are under field.
func fileHookExes(path, field, tool string) []string {
	b, _ := os.ReadFile(path)
	var doc struct {
		Hooks map[string][]map[string]any `json:"hooks"`
	}
	json.Unmarshal(b, &doc)
	var out []string
	for _, hs := range doc.Hooks {
		for _, h := range hs {
			if c, _ := h[field].(string); ourCommand(c, tool) {
				out = append(out, commandExe(c))
			}
		}
	}
	return out
}

// notifyExes returns the program of teardrop's notify line in a Codex config.toml.
func notifyExes(path string) []string {
	b, _ := os.ReadFile(path)
	_, after, ok := strings.Cut(string(b), notifyMark+"\n")
	if !ok {
		return nil
	}
	line, _, _ := strings.Cut(after, "\n")
	_, list, _ := strings.Cut(line, "=")
	var args []string
	if json.Unmarshal([]byte(strings.TrimSpace(list)), &args) != nil || len(args) == 0 {
		return nil
	}
	return []string{filepath.ToSlash(args[0])}
}

// ampPluginExes returns the program teardrop's Amp or OpenCode plugin runs.
func ampPluginExes(plugin []byte) []string {
	_, after, ok := strings.Cut(string(plugin), "const teardrop = ")
	if !ok {
		return nil
	}
	line, _, _ := strings.Cut(after, "\n")
	var exe string
	if json.Unmarshal([]byte(strings.TrimSpace(line)), &exe) != nil {
		return nil
	}
	return []string{filepath.ToSlash(exe)}
}

// codexUntrusted reports whether Codex has had sessions in the last two
// weeks but never ran teardrop's prompt hook in them, which is what Codex
// does with hooks nobody trusted in /hooks.
func codexUntrusted(codexDir string) bool {
	since := time.Now().Add(-14 * 24 * time.Hour)
	var locs []location
	for _, l := range locations("", codexDir) {
		if l.Tool == "Codex" {
			locs = append(locs, l)
		}
	}
	raws, _, _ := load(locs, since)
	if len(raws) == 0 {
		return false
	}
	for _, ev := range sources.ReadJournalEvents(dataDir(), since) {
		if ev.Tool == "codex" && ev.Event == "UserPromptSubmit" {
			return false
		}
	}
	return true
}
