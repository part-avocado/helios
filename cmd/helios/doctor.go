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

	"github.com/part-avocado/helios/internal/sources"
)

// `helios doctor` checks what decides whether this computer's time reaches
// the site: this binary, the site and key, the clock, each tool's hooks, what
// is waiting to send, and the last background error. It says how to fix
// each problem and exits 1 when there is one. `helios status` prints the
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
	claudeDir := fs.String("claude-dir", "", txtFlagClaudeDirs)
	codexDir := fs.String("codex-dir", "", txtFlagCodexDirs)
	fs.Parse(args)
	if printDoctor(os.Stdout, diagnose(*claudeDir, *codexDir, &http.Client{Timeout: 10 * time.Second}, releasesURL)) {
		os.Exit(1)
	}
}

func runStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	claudeDir := fs.String("claude-dir", "", txtFlagClaudeDirs)
	codexDir := fs.String("codex-dir", "", txtFlagCodexDirs)
	fs.Parse(args)
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	worst := levelOK
	for _, f := range diagnose(*claudeDir, *codexDir, &http.Client{Timeout: 10 * time.Second}, releasesURL) {
		fmt.Fprintf(w, "%s\t%s\n", f.Name, f.Detail)
		worst = max(worst, f.Level)
	}
	w.Flush()
	if worst == levelFix {
		fmt.Print(txtStatusNeedsFix)
	}
}

// printDoctor prints the findings with what to do about each, and reports
// whether any needs fixing.
func printDoctor(out io.Writer, findings []finding) bool {
	marks := []string{txtDoctorMarkOK, txtDoctorMarkNote, txtDoctorMarkFix}
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
		fmt.Fprint(out, txtDoctorNothing)
		return false
	}
	fmt.Fprintf(out, txtDoctorToFix, plural(fixes, txtNounProblem))
	return true
}

// diagnose runs every check. releases is where new versions are looked up.
func diagnose(claudeDir, codexDir string, client *http.Client, releases string) []finding {
	var out []finding
	add := func(f finding) { out = append(out, f) }

	exe, exeErr := heliosPath()
	if exeErr != nil {
		add(finding{txtCheckHelios, levelNote, fmt.Sprintf(txtHeliosNoPath, version, exeErr), txtHeliosFixPath})
	} else {
		add(finding{txtCheckHelios, levelOK, fmt.Sprintf(txtHeliosAt, version, exe), ""})
	}
	if version != "dev" {
		if latest, err := latestVersion(client, releases); err != nil {
			add(finding{txtCheckUpdate, levelNote, err.Error(), ""})
		} else if newer(latest, version) {
			fix := txtUpdateFix
			if autoUpdateOn() {
				fix = txtUpdateFixAuto
			}
			add(finding{txtCheckUpdate, levelNote, fmt.Sprintf(txtUpdateOut, latest), fix})
		} else if autoUpdateOn() {
			add(finding{txtCheckUpdate, levelOK, txtUpdateLatestAuto, ""})
		} else {
			add(finding{txtCheckUpdate, levelOK, txtUpdateLatest, ""})
		}
	}

	server, err := serverURL("")
	key := ""
	if err == nil {
		key, err = syncKey("", server)
	}
	// A disposable machine sends as the "cloud" computer once both secrets
	// are set. With one missing, its hooks keep a journal that goes with it.
	flag := cloudFlag()
	var missing []string
	for _, v := range []string{"HELIOS_SERVER", "HELIOS_KEY"} {
		if os.Getenv(v) == "" {
			missing = append(missing, v)
		}
	}
	switch {
	case cloudEnv():
		add(finding{txtCheckCloud, levelOK, fmt.Sprintf(txtCloudOn, flag), ""})
	case flag != "":
		names := strings.Join(missing, txtAnd)
		add(finding{txtCheckCloud, levelNote, fmt.Sprintf(txtCloudOff, flag, names, map[bool]string{false: txtIsNot, true: txtAreNot}[len(missing) > 1]), fmt.Sprintf(txtCloudOffFix, names)})
	}
	switch {
	case err != nil:
		add(finding{txtCheckSite, levelFix, err.Error(), ""})
	case key == "" && flag != "":
		add(finding{txtCheckSite, levelFix, fmt.Sprintf(txtSiteNoKey, server), txtSiteNoKeyCloud})
	case key == "":
		add(finding{txtCheckSite, levelFix, fmt.Sprintf(txtSiteNoKey, server), fmt.Sprintf(txtSiteFixLogin, server)})
	default:
		who, status, err := whoami(client, server, key)
		switch {
		case err == nil:
			add(finding{txtCheckSite, levelOK, fmt.Sprintf(txtSiteSignedIn, who.Name, who.Handle, server), ""})
			if w := clockWarning(who.Skew); w != "" {
				add(finding{txtCheckClock, levelFix, w, ""})
			} else {
				add(finding{txtCheckClock, levelOK, txtClockMatches, ""})
			}
		case status == http.StatusUnauthorized && os.Getenv("HELIOS_KEY") != "":
			// A login would save a key that the one in the environment still overrides.
			add(finding{txtCheckSite, levelFix, fmt.Sprintf(txtSiteBadEnvKey, server), fmt.Sprintf(txtSiteBadEnvKeyFix, server)})
		case status == http.StatusUnauthorized:
			add(finding{txtCheckSite, levelFix, fmt.Sprintf(txtSiteBadKey, server), fmt.Sprintf(txtSiteBadKeyFix, server)})
		case status == http.StatusUpgradeRequired:
			add(finding{txtCheckSite, levelFix, strings.TrimPrefix(err.Error(), txtServerSaidPrefix+"426 Upgrade Required: "), txtUpdateFix})
		case status == http.StatusForbidden:
			add(finding{txtCheckSite, levelFix, strings.TrimPrefix(err.Error(), txtServerSaidPrefix+"403 Forbidden: "), ""})
		case status == http.StatusNotFound:
			add(finding{txtCheckSite, levelNote, fmt.Sprintf(txtSiteOld, server), ""})
		default:
			add(finding{txtCheckSite, levelFix, fmt.Sprintf(txtSiteUnreachable, server, err.Error()), txtSiteUnreachFix})
		}
	}

	out = append(out, hookFindings(claudeDir, codexDir, exe)...)

	for _, outbox := range []string{localOutbox, relayOutbox} {
		if info, err := os.Stat(filepath.Join(dataDir(), outbox)); err == nil && info.Size() > maxOutboxBytes {
			add(finding{txtCheckOutbox, levelFix, txtOutboxFull, txtOutboxFullFix})
		}
	}
	if waiting := waitingRecords(); waiting > 0 {
		add(finding{txtCheckWaiting, levelNote, fmt.Sprintf(txtWaitingRecords, plural(waiting, txtNounRecord)), txtWaitingFix})
	} else {
		add(finding{txtCheckWaiting, levelOK, txtWaitingNothing, ""})
	}
	// A cloud machine never syncs: its hooks send everything, and a sync
	// would make it an account key of its own, for a computer soon gone.
	if server != "" && !cloudEnv() {
		if info, err := os.Stat(filepath.Join(dataDir(), "last-sync")); err != nil {
			add(finding{txtCheckLastSync, levelNote, txtLastSyncNever, txtLastSyncFix})
		} else if time.Since(info.ModTime()) > 72*time.Hour {
			add(finding{txtCheckLastSync, levelNote, ago(info.ModTime()), txtLastSyncFix})
		} else {
			add(finding{txtCheckLastSync, levelOK, ago(info.ModTime()), ""})
		}
	}
	if e, ok := readLastError(); ok {
		again := "helios sync"
		switch e.Command {
		case "relay":
			again = "helios relay -verbose"
		case "update":
			again = "helios update"
		}
		add(finding{txtCheckLastError, levelFix, fmt.Sprintf(txtLastErrorFailed, e.Command, ago(e.Time), e.Message), fmt.Sprintf(txtLastErrorFix, again)})
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
			out = append(out, hookFinding(txtCheckClaude, claudeShapeExes(filepath.Join(loc.Dir, "settings.json"), "claude-code"), exe, "claude"))
		}
	}
	if dir := codexHome(); exists(dir) {
		exes := claudeShapeExes(filepath.Join(dir, "hooks.json"), "codex")
		f := hookFinding(txtCheckCodex, exes, exe, "codex")
		if f.Level == levelOK && codexUntrusted(codexDir) {
			f = finding{txtCheckCodex, levelNote, txtCodexUntrusted, txtCodexUntrustedFix}
		}
		out = append(out, f)
		out = append(out, hookFinding(txtCheckNotify, notifyExes(filepath.Join(dir, "config.toml")), exe, "codex"))
	}
	home, _ := os.UserHomeDir()
	if dir := filepath.Join(home, ".cursor"); exists(dir) {
		out = append(out, hookFinding(txtCheckCursor, fileHookExes(filepath.Join(dir, "hooks.json"), "command", "cursor"), exe, "cursor"))
	}
	if dir := filepath.Join(home, ".copilot"); exists(dir) {
		out = append(out, hookFinding(txtCheckCopilot, fileHookExes(filepath.Join(dir, "hooks", "helios.json"), "bash", "copilot"), exe, "copilot"))
	}
	if b, err := os.ReadFile(ampPluginPath()); err == nil || ampInstalled() {
		f := hookFinding(txtCheckAmp, ampPluginExes(b), exe, "amp")
		if f.Level == levelOK && exe != "" && string(b) != string(renderAmpPlugin(exe)) {
			f = finding{txtCheckAmp, levelNote, txtPluginOld, fmt.Sprintf(txtHookFixSetup, "amp")}
		}
		out = append(out, f)
	}
	if b, err := os.ReadFile(openCodePluginPath()); err == nil || openCodeInstalled() {
		f := hookFinding(txtCheckOpenCode, ampPluginExes(b), exe, "opencode")
		if f.Level == levelOK && exe != "" && string(b) != string(renderOpenCodePlugin(exe)) {
			f = finding{txtCheckOpenCode, levelNote, txtPluginOld, fmt.Sprintf(txtHookFixSetup, "opencode")}
		}
		out = append(out, f)
	}
	return out
}

// hookFinding says whether a tool's hooks run this helios, given the
// programs they run. exe is "" when this helios has no fixed path.
func hookFinding(name string, exes []string, exe, tool string) finding {
	setup := fmt.Sprintf(txtHookFixSetup, tool)
	if len(exes) == 0 {
		return finding{name, levelFix, txtHookMissing, setup}
	}
	for _, e := range exes {
		if _, err := os.Stat(filepath.FromSlash(e)); err != nil {
			return finding{name, levelFix, fmt.Sprintf(txtHookGone, e), setup}
		}
	}
	for _, e := range exes {
		if exe != "" && e != filepath.ToSlash(exe) {
			return finding{name, levelNote, fmt.Sprintf(txtHookOther, e), fmt.Sprintf(txtHookOtherFix, tool)}
		}
	}
	return finding{name, levelOK, txtHookInstalled, ""}
}

// commandExe returns the program a hook command runs: the quoted path at its start.
func commandExe(command string) string {
	if rest, ok := strings.CutPrefix(command, `"`); ok {
		exe, _, _ := strings.Cut(rest, `"`)
		return exe
	}
	return ""
}

// claudeShapeExes returns the programs of helios's hooks for tool in a
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

// fileHookExes returns the programs of helios's hooks in a Cursor or
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

// notifyExes returns the program of helios's notify line in a Codex config.toml.
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

// ampPluginExes returns the program helios's Amp or OpenCode plugin runs.
func ampPluginExes(plugin []byte) []string {
	_, after, ok := strings.Cut(string(plugin), "const helios = ")
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
// weeks but never ran helios's prompt hook in them, which is what Codex
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
