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
	"strings"
	"text/tabwriter"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

// keepDays is how long setup asks Claude Code to keep transcripts. Claude
// Code deletes them after 30 days by default, which would erase history.
const keepDays = 3650

// setupNames maps the names `teardrop setup` accepts to the tool they mean.
var setupNames = map[string]string{
	"claude": "Claude Code", "claude-code": "Claude Code", "claudecode": "Claude Code",
	"codex": "Codex",
	"amp":   "Amp", "ampcode": "Amp",
}

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
			return nil, fmt.Errorf("unknown tool %q; use claude, codex, or amp", fs.Arg(0))
		}
		only[tool] = true
		args = fs.Args()[1:]
	}
}

// runSetup checks which tools teardrop can read and fixes settings that would
// lose history. Naming tools limits it to those. It changes nothing without
// asking, and is safe to rerun.
func runSetup(args []string) {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	yes := fs.Bool("yes", false, "apply recommended changes without asking")
	removeHooks := fs.Bool("remove-hooks", false, "remove teardrop's Claude Code hooks and Amp plugin (run this before uninstalling)")
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: teardrop setup [flags] [claude] [codex] [amp]")
		fmt.Fprintln(os.Stderr, "       Sets up every tool it finds, or only the ones you name.")
		fmt.Fprintln(os.Stderr)
		fs.PrintDefaults()
	}
	only, err := parseSetupArgs(fs, args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "teardrop setup:", err)
		os.Exit(2)
	}
	want := func(tool string) bool { return len(only) == 0 || only[tool] }

	fmt.Println("Looking for AI coding tools on this machine...")
	fmt.Println()
	var locs []location
	for _, loc := range locations(*claudeDir, *codexDir) {
		if want(loc.Tool) {
			locs = append(locs, loc)
		}
	}
	_, stats, warnings := load(locs, time.Time{})
	journal, _ := sources.ReadJournal(dataDir())
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	found := map[string]bool{} // tools present on this machine
	for _, f := range stats {
		status := "not installed here"
		switch {
		case f.Sessions > 0:
			status = fmt.Sprintf("ok: %s, newest %s", plural(f.Sessions, "session"), ago(f.Newest))
			found[f.Tool] = true
		case exists(f.Dir):
			status = "installed, no sessions yet"
			found[f.Tool] = true
		}
		fmt.Fprintf(w, "  %s\t%s\t%s\n", f.Tool, f.Dir, status)
	}
	if want("Amp") {
		fmt.Fprintf(w, "  Amp\t%s\t%s\n", ampDir(), ampStatus(journal))
	}
	w.Flush()
	if len(warnings) > 0 {
		fmt.Printf("\n  %s could not be read and will be skipped (run `teardrop -verbose` to list them).\n", plural(len(warnings), "log file"))
	}

	events := 0
	for _, j := range journal {
		events += len(j.Events)
	}
	if events > 0 {
		fmt.Printf("\n  Hook journal: %s from %s in %s\n", plural(events, "event"), plural(len(journal), "session"), dataDir())
	}

	for _, f := range stats {
		if f.Tool == "Claude Code" && exists(f.Dir) {
			if !*removeHooks {
				checkRetention(f.Dir, *yes)
			}
			checkHooks(f.Dir, *yes, *removeHooks)
		}
	}
	if only["Codex"] && found["Codex"] && !*removeHooks {
		fmt.Println("\n  Codex needs no setup: teardrop reads its logs as they are.")
	}
	if want("Amp") {
		if !*removeHooks {
			ampAppOnly()
		}
		// The plugin counts as Amp being set up, even before Amp is installed.
		plugin := checkAmpPlugin(*yes, *removeHooks)
		found["Amp"] = plugin || ampInstalled() || only["Amp"]
	}
	if _, err := exec.LookPath("git"); err != nil {
		fmt.Println("\n  Note: git is not installed, so projects are grouped by folder instead of by repository.")
	}

	fmt.Println()
	anyFound := false
	for _, tool := range []string{"Claude Code", "Codex", "Amp"} {
		anyFound = anyFound || found[tool]
		if only[tool] && !found[tool] {
			fmt.Printf("%s was not found on this machine. If its logs are in a custom place, pass -%s-dir.\n", tool, strings.ToLower(strings.Fields(tool)[0]))
		}
	}
	switch {
	case !anyFound && len(only) == 0:
		fmt.Println("No supported tools found. teardrop reads Claude Code and Codex logs, and")
		fmt.Println("records Amp through a plugin. If yours keep logs in a custom place, pass")
		fmt.Println("-claude-dir or -codex-dir.")
	case !anyFound:
	case *removeHooks && len(only) == 0:
		fmt.Println("Done. You can now delete the teardrop binary.")
	case *removeHooks:
		fmt.Println("Done.")
	default:
		fmt.Println("Done. Nothing needs to stay running. Run `teardrop` any time to see your timeline.")
	}
}

// checkRetention makes sure Claude Code keeps transcripts long enough to count.
func checkRetention(dir string, yes bool) {
	path := filepath.Join(dir, "settings.json")
	settings, err := readSettings(path)
	if err != nil {
		fmt.Printf("\n  Could not read %s (%v).\n  To keep Claude Code history, set \"cleanupPeriodDays\": %d in it by hand.\n", path, err, keepDays)
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
	fmt.Printf("\n  Claude Code deletes transcripts after %d days, so older work would disappear\n", days)
	fmt.Printf("  from your stats. Keep them for %d days instead? This edits %s\n", keepDays, path)
	if !yes && !confirm("  (a backup is saved next to it) [Y/n] ") {
		fmt.Println("  Skipped. Run `teardrop setup` again to change your mind.")
		return
	}
	settings["cleanupPeriodDays"] = json.RawMessage(fmt.Sprint(keepDays))
	if err := writeSettings(path, settings); err != nil {
		fmt.Printf("  Could not update it: %v\n", err)
		return
	}
	fmt.Println("  Updated.")
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
		return nil, errors.New("it is not valid JSON")
	}
	return m, nil
}

// writeSettings replaces the file atomically so an interrupted write never
// leaves Claude Code with a broken settings file. The first edit saves the
// original next to it; later edits keep that backup.
func writeSettings(path string, m map[string]json.RawMessage) error {
	backup := path + ".teardrop-backup"
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
	tmp := path + ".teardrop-tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// confirm asks a yes/no question, defaulting to yes. Without a terminal to
// ask on, it answers no.
func confirm(q string) bool {
	if st, err := os.Stdin.Stat(); err != nil || st.Mode()&os.ModeCharDevice == 0 {
		fmt.Println("\n  (no terminal to ask on; rerun with -yes to apply)")
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
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
