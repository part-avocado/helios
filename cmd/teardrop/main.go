// Command teardrop prints how much time you spent engaged with AI coding
// sessions, per project, from Claude Code and Codex logs on this machine.
//
//	teardrop          show your timeline for the last 7 days
//	teardrop setup    check which tools are found, install hooks, fix settings that lose history
//	teardrop hook claude-code   record one Claude Code hook event (run by Claude Code)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/textscore"
	"github.com/part-avocado/teardrop/internal/timeline"
)

// version is set by the release build.
var version = "dev"

// A prompt with more than this share of unrecognized words earns no time.
const noiseThreshold = 0.5

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "setup":
			runSetup(os.Args[2:])
			return
		case "hook":
			runHook(os.Args[2:])
			return
		}
	}
	claudeDir := flag.String("claude-dir", "", "Claude Code config directories, comma-separated (default: $CLAUDE_CONFIG_DIR, ~/.claude, ~/.config/claude)")
	codexDir := flag.String("codex-dir", "", "Codex home directories, comma-separated (default: $CODEX_HOME, ~/.codex)")
	since := flag.String("since", "7d", "only count events newer than this, such as 24h, 7d, or 30d")
	asJSON := flag.Bool("json", false, "print the report as JSON")
	verbose := flag.Bool("verbose", false, "list log files that could not be read")
	showVersion := flag.Bool("version", false, "print the version and exit")
	rules := timeline.DefaultRules
	flag.DurationVar(&rules.ComposeCap, "compose-cap", rules.ComposeCap, "max credit for reading output and writing one prompt")
	flag.DurationVar(&rules.WatchCap, "watch-cap", rules.WatchCap, "max credit for watching the agent after a prompt")
	flag.DurationVar(&rules.BlockGap, "block-gap", rules.BlockGap, "join work blocks separated by less than this")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: teardrop [flags]   show your AI coding timeline")
		fmt.Fprintln(os.Stderr, "       teardrop setup      check which tools are found, install hooks, fix settings that lose history")
		fmt.Fprintln(os.Stderr)
		flag.PrintDefaults()
	}
	flag.Parse()
	if *showVersion {
		fmt.Println("teardrop", version)
		return
	}
	window, err := parseSince(*since)
	check(err)

	raws, _, warnings := load(locations(*claudeDir, *codexDir))
	journal, jw := sources.ReadJournal(dataDir())
	raws = mergeJournal(raws, journal)
	warnings = append(warnings, jw...)
	reportWarnings(warnings, *verbose)

	cutoff := time.Now().Add(-window)
	type resolved struct {
		project timeline.Project
		root    string
	}
	projects := map[string]resolved{}
	vocabs := map[string]textscore.Vocab{}
	var sessions []timeline.Session
	for _, r := range raws {
		key := r.Cwd + "\x00" + r.GitURL
		p, ok := projects[key]
		if !ok {
			p.project, p.root = resolveProject(r.Cwd, r.GitURL)
			projects[key] = p
		}
		var ev []timeline.Event
		for i, e := range r.Events {
			if !e.Time.After(cutoff) {
				continue
			}
			if s, ok := r.Scores[i]; ok && s.Judged > 0 {
				// Read the project's files only when a prompt has words the dictionary lacks.
				v, built := vocabs[p.root]
				if len(s.Unknown) > 0 && !built {
					v = textscore.RepoVocab(p.root)
					vocabs[p.root] = v
				}
				if s.Noise(v) > noiseThreshold {
					e.Kind = timeline.Noise
				}
			}
			ev = append(ev, e)
		}
		if len(ev) > 0 {
			sessions = append(sessions, timeline.Session{Tool: r.Tool, ID: r.ID, Project: p.project, Events: ev})
		}
	}

	rep := timeline.Build(sessions, rules)
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		check(enc.Encode(rep))
		return
	}
	if len(rep.Blocks) == 0 {
		fmt.Printf("No Claude Code or Codex sessions found in the last %s.\n", *since)
		if len(raws) == 0 {
			fmt.Println("Run `teardrop setup` to see where teardrop looks for them.")
		} else {
			fmt.Println("Try a longer window, such as `teardrop -since 30d`.")
		}
		return
	}
	printReport(rep, len(sessions))
}

func printReport(rep timeline.Report, nSessions int) {
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "WHEN\tPROJECT\tENGAGED\tSPAN\tPROMPTS\tTOKENS IN/OUT\tTOOLS")
	day := ""
	for _, b := range rep.Blocks {
		start, end := b.Start.Local(), b.End.Local()
		if d := start.Format("Mon Jan 2"); d != day {
			day = d
			fmt.Fprintf(w, "%s\t\t\t\t\t\t\n", d)
		}
		fmt.Fprintf(w, "  %s-%s\t%s\t%s\t%s\t%d\t%s\t%s\n",
			start.Format("15:04"), end.Format("15:04"), b.Project.Name,
			dur(time.Duration(b.Engaged)), dur(end.Sub(start)), b.Prompts, tokens(b.In, b.Out), strings.Join(b.Tools, ","))
	}
	w.Flush()

	fmt.Println()
	w = tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "PROJECT\tENGAGED\tSESSION TIME\tPROMPTS\tNOISE\tTOKENS IN/OUT")
	noise := 0
	for _, p := range rep.Projects {
		noise += p.NoisePrompts
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%d\t%s\n", p.Project.Name, dur(time.Duration(p.Engaged)),
			dur(time.Duration(p.SessionTime)), p.Prompts, p.NoisePrompts, tokens(p.In, p.Out))
	}
	w.Flush()
	fmt.Printf("\nTotal engaged: %s across %s and %s\n", dur(time.Duration(rep.Engaged)), plural(len(rep.Projects), "project"), plural(nSessions, "session"))
	if noise > 0 {
		fmt.Printf("%s mostly unrecognized words and earned no time (NOISE).\n", plural(noise, "prompt")+map[bool]string{true: " was", false: " were"}[noise == 1])
	}
}

func reportWarnings(warnings []string, verbose bool) {
	if len(warnings) == 0 {
		return
	}
	if verbose {
		for _, w := range warnings {
			fmt.Fprintln(os.Stderr, "teardrop:", w)
		}
		return
	}
	fmt.Fprintf(os.Stderr, "teardrop: skipped %s that could not be read (-verbose lists them)\n", plural(len(warnings), "log file"))
}

// parseSince accepts Go durations plus a d suffix for days.
func parseSince(s string) (time.Duration, error) {
	if n, ok := strings.CutSuffix(s, "d"); ok {
		var days float64
		if _, err := fmt.Sscanf(n, "%g", &days); err == nil && days > 0 {
			return time.Duration(days * 24 * float64(time.Hour)), nil
		}
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("-since %q: use a length such as 24h, 7d, or 30d", s)
	}
	return d, nil
}

// resolveProject names a project by its git remote, else its repository root,
// else its directory. It also returns the directory to read vocabulary from.
func resolveProject(cwd, gitURL string) (timeline.Project, string) {
	root := cwd
	if top := gitOut(cwd, "rev-parse", "--show-toplevel"); top != "" {
		root = filepath.FromSlash(top)
	}
	if gitURL == "" {
		gitURL = gitOut(cwd, "config", "--get", "remote.origin.url")
	}
	if gitURL != "" {
		key := normalizeRemote(gitURL)
		return timeline.Project{Key: key, Name: filepath.Base(key)}, root
	}
	if root == "" {
		return timeline.Project{Key: "(unknown)", Name: "(unknown)"}, ""
	}
	return timeline.Project{Key: root, Name: filepath.Base(root)}, root
}

// normalizeRemote maps git@host:o/r.git and https://host/o/r to host/o/r.
func normalizeRemote(u string) string {
	u = strings.TrimSuffix(strings.TrimSpace(u), ".git")
	if i := strings.Index(u, "://"); i >= 0 {
		u = u[i+3:]
		if at := strings.Index(u, "@"); at >= 0 && at < strings.Index(u+"/", "/") {
			u = u[at+1:]
		}
	} else if at := strings.Index(u, "@"); at >= 0 {
		u = strings.Replace(u[at+1:], ":", "/", 1)
	}
	return strings.ToLower(u)
}

func gitOut(dir string, args ...string) string {
	if dir == "" || !exists(dir) {
		return ""
	}
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func dur(d time.Duration) string {
	m := int(d.Round(time.Minute) / time.Minute)
	if m < 60 {
		return fmt.Sprintf("%dm", m)
	}
	return fmt.Sprintf("%dh%02dm", m/60, m%60)
}

func tokens(in, out int64) string {
	if in == 0 && out == 0 {
		return "-"
	}
	return count(in) + "/" + count(out)
}

func count(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	}
	return fmt.Sprint(n)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "teardrop:", err)
		os.Exit(1)
	}
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
