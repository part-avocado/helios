package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/part-avocado/helios/internal/sources"
)

// keepDays is how long setup asks Claude Code to keep transcripts. Claude
// Code deletes them after 30 days by default, which would erase history.
const keepDays = 3650

// parseSetupArgs parses flags and tool names in any order, so both
// `setup -yes amp` and `setup amp -yes` work. It returns the tools named;
// none means every tool.
func parseSetupArgs(fs *flag.FlagSet, args []string) (map[string]bool, error) {
	only := map[string]bool{}
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return only, nil
		}
		tool, ok := setupNames[strings.ToLower(fs.Arg(0))]
		if !ok {
			return nil, fmt.Errorf(txtSetupUnknownTool, fs.Arg(0))
		}
		only[tool] = true
		args = fs.Args()[1:]
	}
}

// runSetup checks which tools helios can read and fixes settings that would
// lose history. Naming tools limits it to those. It changes nothing without
// asking, and is safe to rerun.
func runSetup(args []string) {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	yes := fs.Bool("yes", false, txtFlagYes)
	removeHooks := fs.Bool("remove-hooks", false, txtFlagRemoveHooks)
	claudeDir := fs.String("claude-dir", "", txtFlagClaudeDirs)
	codexDir := fs.String("codex-dir", "", txtFlagCodexDirs)
	project := fs.Bool("project", false, txtFlagProject)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, txtSetupUsage)
		fs.PrintDefaults()
	}
	only, err := parseSetupArgs(fs, args)
	if err != nil {
		fmt.Fprintln(os.Stderr, txtSetupErrPrefix, err)
		os.Exit(2)
	}
	want := func(tool string) bool { return len(only) == 0 || only[tool] }
	if *project {
		for tool := range only {
			if !slices.Contains(projectTools, tool) {
				fmt.Fprintf(os.Stderr, txtSetupProjectOnly, tool)
				os.Exit(2)
			}
		}
		cwd, _ := os.Getwd()
		for _, tool := range projectTools {
			switch {
			case !want(tool):
			case tool == "Claude Code":
				check(setupProject(cwd, *yes, *removeHooks))
			default:
				check(setupToolProject(cwd, tool, *yes, *removeHooks))
			}
		}
		return
	}

	fmt.Print(txtSetupLooking)
	var locs []location
	for _, loc := range locations(*claudeDir, *codexDir) {
		if want(loc.Tool) {
			locs = append(locs, loc)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && *yes && only["GitHub Copilot"] && !*removeHooks {
		// Copilot reads hooks from ~/.copilot, which it may not have made yet.
		os.MkdirAll(filepath.Join(home, ".copilot"), 0o700)
	}
	if *yes && !*removeHooks && only["Claude Code"] {
		// A fresh cloud container has no ~/.claude yet, and naming claude
		// means it is wanted, so make the default folder for the hooks.
		makeDefaultDir(locs, "Claude Code")
	}
	_, stats, warnings := load(locs, time.Time{})
	journal, _ := sources.ReadJournal(dataDir())
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	found := map[string]bool{} // tools present on this machine
	for _, f := range stats {
		status := txtStatusNotInstalled
		switch {
		case f.Sessions > 0:
			status = fmt.Sprintf(txtStatusOK, plural(f.Sessions, txtNounSession), ago(f.Newest))
			found[f.Tool] = true
		case exists(f.Dir):
			status = txtStatusInstalledNoSession
			found[f.Tool] = true
		}
		fmt.Fprintf(w, "  %s\t%s\t%s\n", f.Tool, f.Dir, status)
	}
	if want("Amp") {
		fmt.Fprintf(w, "  Amp\t%s\t%s\n", ampDir(), ampStatus(journal))
	}
	if want("OpenCode") {
		fmt.Fprintf(w, "  OpenCode\t%s\t%s\n", openCodeDir(), openCodeStatus(journal))
	}
	if want("Antigravity") {
		fmt.Fprintf(w, "  Antigravity\t%s\t%s\n", geminiDir(), antigravityStatus(journal))
	}
	w.Flush()
	if len(warnings) > 0 {
		fmt.Printf(txtSetupUnreadable, plural(len(warnings), txtNounLogFile))
	}

	events := 0
	for _, j := range journal {
		events += len(j.Events)
	}
	if events > 0 {
		fmt.Printf(txtSetupJournal, plural(events, txtNounEvent), plural(len(journal), txtNounSession), dataDir())
	}

	for _, f := range stats {
		if f.Tool == "Claude Code" && exists(f.Dir) {
			if !*removeHooks {
				checkRetention(f.Dir, *yes)
			}
			checkHooks(f.Dir, *yes, *removeHooks)
		}
	}
	if want("Codex") {
		checkCodex(*yes, *removeHooks)
	}
	checkFileHooks(want, *yes, *removeHooks)
	if want("Amp") {
		if !*removeHooks {
			ampAppOnly()
		}
		// The plugin counts as Amp being set up, even before Amp is installed.
		plugin := checkAmpPlugin(*yes, *removeHooks)
		found["Amp"] = plugin || ampInstalled() || only["Amp"]
	}
	if want("OpenCode") {
		found["OpenCode"] = checkOpenCodePlugin(*yes, *removeHooks) || openCodeInstalled()
	}
	if want("Antigravity") {
		checkAntigravity(*yes, *removeHooks)
		found["Antigravity"] = antigravityInstalled()
	}
	if _, err := exec.LookPath("git"); err != nil {
		fmt.Print(txtSetupNoGit)
	}

	fmt.Println()
	anyFound := false
	for _, tool := range []string{"Claude Code", "Codex", "Amp", "OpenCode", "Antigravity"} {
		anyFound = anyFound || found[tool]
		switch {
		case !only[tool] || found[tool]:
		case tool == "OpenCode":
			fmt.Print(txtSetupNoOpenCode)
		case tool == "Antigravity":
			fmt.Printf(txtSetupNoAntigrav, geminiDir())
		default:
			fmt.Printf(txtSetupToolNotFound, tool, strings.ToLower(strings.Fields(tool)[0]))
		}
	}
	switch {
	case !anyFound && len(only) == 0:
		fmt.Print(txtSetupNoTools)
	case !anyFound:
	case *removeHooks && len(only) == 0:
		fmt.Print(txtSetupDoneRemoved)
	case *removeHooks:
		fmt.Print(txtDone)
	default:
		fmt.Print(txtSetupDone)
	}
}

// checkRetention makes sure Claude Code keeps transcripts long enough to count.
func checkRetention(dir string, yes bool) {
	path := filepath.Join(dir, "settings.json")
	settings, err := readSettings(path)
	if err != nil {
		fmt.Printf(txtRetentionUnreadable, path, err, keepDays)
		return
	}
	days := 30
	if raw, ok := settings["cleanupPeriodDays"]; ok {
		if json.Unmarshal(raw, &days) != nil {
			days = 30
		}
	}
	if days >= 365 {
		return
	}
	fmt.Printf(txtRetentionAsk, days, keepDays, path)
	if !yes && !confirm(txtRetentionConfirm) {
		fmt.Print(txtSkippedRerun)
		return
	}
	settings["cleanupPeriodDays"] = json.RawMessage(fmt.Sprint(keepDays))
	if err := writeSettings(path, settings); err != nil {
		fmt.Printf(txtRetentionFailed, err)
		return
	}
	fmt.Print(txtRetentionUpdated)
}

func readSettings(path string) (map[string]json.RawMessage, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]json.RawMessage{}
	if len(strings.TrimSpace(string(b))) == 0 {
		return m, nil
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, errors.New(txtNotJSON)
	}
	return m, nil
}

// writeSettings replaces the file atomically so an interrupted write never
// leaves Claude Code with a broken settings file. The first edit saves the
// original next to it; later edits keep that backup.
func writeSettings(path string, m map[string]json.RawMessage) error {
	backup := path + ".helios-backup"
	if _, err := os.Stat(backup); errors.Is(err, os.ErrNotExist) {
		if old, err := os.ReadFile(path); err == nil {
			if err := os.WriteFile(backup, old, 0o600); err != nil {
				return err
			}
		}
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".helios-tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// confirm asks a yes/no question, defaulting to yes. Without a terminal to
// ask on, it answers no.
func confirm(q string) bool {
	if st, err := os.Stdin.Stat(); err != nil || st.Mode()&os.ModeCharDevice == 0 {
		fmt.Print(txtNoTerminal)
		return false
	}
	fmt.Print(q)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		fmt.Println()
		return false // end of input, such as /dev/null, is not a yes
	}
	a := strings.ToLower(strings.TrimSpace(line))
	return a == "" || a == "y" || a == "yes"
}

func ago(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Hour:
		return fmt.Sprintf(txtAgoMinutes, int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf(txtAgoHours, int(d.Hours()))
	default:
		return fmt.Sprintf(txtAgoDays, int(d.Hours()/24))
	}
}

// makeDefaultDir creates tool's first folder in locs, its default, when none
// of its folders exists. With one there, the tool is already set up in it.
func makeDefaultDir(locs []location, tool string) {
	first := ""
	for _, loc := range locs {
		if loc.Tool != tool {
			continue
		}
		if exists(loc.Dir) {
			return
		}
		if first == "" {
			first = loc.Dir
		}
	}
	if first != "" {
		os.MkdirAll(first, 0o755)
	}
}

// What a repository's own Claude Code settings run, on whatever machine the
// repository is opened: a cloud session's container starts without helios
// and without ~/.claude. Both do nothing unless HELIOS_KEY is set, so
// nothing changes for a teammate who doesn't use helios. With -project the
// hook also does nothing where the person's own Claude Code settings already
// run helios's hook (userHooked), as on a computer that is signed in, or a
// cloud machine the installer set up: one event is recorded once. helios is
// found on PATH, or where the installer puts it. Neither prints anything:
// Claude Code would show a session's start and a prompt's output to the model.
const (
	projectHook = `[ -z "$HELIOS_KEY" ] || PATH="$PATH:$HOME/.local/bin" helios ` + hookArgs + ` ` + projectFlag + ` 2>/dev/null || true`
	// At a session's start, helios is installed first if it is missing.
	projectStart = `[ -z "$HELIOS_KEY" ] || { PATH="$PATH:$HOME/.local/bin"; command -v helios >/dev/null || curl -fsSL https://raw.githubusercontent.com/part-avocado/helios/main/install.sh | HELIOS_NO_SETUP=1 sh >/dev/null 2>&1; helios ` + hookArgs + ` ` + projectFlag + ` 2>/dev/null; } || true`
)

// setProjectHooks puts helios's hooks for a repository in its Claude Code
// settings, or with install false takes them out, keeping every other hook
// and setting. It reports whether the settings changed.
func setProjectHooks(settings map[string]json.RawMessage, install bool) (bool, error) {
	add := map[string]map[string]any{}
	if install {
		for _, e := range hookEvents {
			add[e] = map[string]any{"type": "command", "command": projectHook, "timeout": 10}
		}
		// Long enough to download helios.
		add["SessionStart"] = map[string]any{"type": "command", "command": projectStart, "timeout": 120}
	}
	return setHookEntries(settings, "claude-code", add)
}

// setupProject writes helios's hooks to .claude/settings.json of the git
// repository that holds dir, or removes them from it.
func setupProject(dir string, yes, remove bool) error {
	root := gitOut(dir, "rev-parse", "--show-toplevel")
	if root == "" {
		return errors.New(txtNotInRepoClaude)
	}
	path := filepath.Join(root, ".claude", "settings.json")
	settings, err := readSettings(path)
	if err != nil {
		return fmt.Errorf(txtCouldNotRead, path, err)
	}
	changed, err := setProjectHooks(settings, !remove)
	if err != nil {
		return fmt.Errorf(txtCouldNotSetUpIn, path, err)
	}
	if !changed {
		if remove {
			fmt.Printf(txtProjectNoHooks, path)
		} else {
			fmt.Printf(txtProjectClaudeOK, path)
		}
		return nil
	}
	if !remove {
		fmt.Print(txtProjectClaudeAsk)
		if !yes && !confirm(fmt.Sprintf(txtProjectEditsConfirm, path)) {
			fmt.Print(txtSkipped)
			return nil
		}
	}
	// No backup next to it, and readable by all: this file is committed.
	b, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".helios-tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if remove {
		fmt.Printf(txtRemovedHooksFrom, path)
		return nil
	}
	fmt.Printf(txtProjectClaudeAdded, path)
	return nil
}
