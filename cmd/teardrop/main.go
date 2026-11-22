// Command teardrop prints how much time you spent engaged with AI coding
// sessions, per project, from Claude Code and Codex logs on this machine and
// from the journal that its Claude Code hooks and Amp plugin write.
//
//	teardrop          show your timeline for the last 7 days
//	teardrop setup    check which tools are found, install hooks, fix settings that lose history
//	teardrop setup amp   set up one tool only: claude, codex, or amp
//	teardrop update   replace this teardrop with the latest release
//	teardrop hook claude-code   record one Claude Code hook event (run by Claude Code)
//	teardrop relay    send events recorded in Amp's cloud to your teardrop site, and count them there (run by the Amp cloud plugin)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
		case "dashboard":
			runDashboard(os.Args[2:])
			return
		case "export":
			runExport(os.Args[2:])
			return
		case "sync":
			runSync(os.Args[2:])
			return
		case "update":
			runUpdate(os.Args[2:])
			return
		case "relay":
			runRelay(os.Args[2:])
			return
		case "submit":
			runSubmit(os.Args[2:])
			return
		case "server":
			runServer(os.Args[2:])
			return
		case "help":
			os.Args[1] = "-h"
		case "version":
			os.Args[1] = "-version"
		}
	}
	claudeDir := flag.String("claude-dir", "", "Claude Code config directories, comma-separated (default: $CLAUDE_CONFIG_DIR, ~/.claude, ~/.config/claude)")
	codexDir := flag.String("codex-dir", "", "Codex home directories, comma-separated (default: $CODEX_HOME, ~/.codex)")
	since := flag.String("since", "7d", "only count events newer than this, such as 24h, 7d, or 30d")
	asJSON := flag.Bool("json", false, "print the report as JSON")
	verbose := flag.Bool("verbose", false, "list log files that could not be read")
	var live bool
	flag.BoolVar(&live, "live", false, "keep the timeline on screen and update it as you work (also -l)")
	flag.BoolVar(&live, "l", false, "short for -live")
	every := flag.Duration("every", 3*time.Second, "with -live, how often to reread the logs")
	showVersion := flag.Bool("version", false, "print the version and exit")
	// The rules are not flags: the help would spell out how time is credited,
	// and hours counted with other rules wouldn't match an export or a sync.
	rules := timeline.DefaultRules
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: teardrop [flags]   show your AI coding timeline (-l keeps it updating live)")
		fmt.Fprintln(os.Stderr, "       teardrop setup      check which tools are found, install hooks, fix settings that lose history")
		fmt.Fprintln(os.Stderr, "       teardrop setup amp  set up one tool only: claude, codex, or amp")
		fmt.Fprintln(os.Stderr, "       teardrop dashboard  open a live dashboard of your stats in the browser")
		fmt.Fprintln(os.Stderr, "       teardrop export     write a signed report to upload on the website, under Settings")
		fmt.Fprintln(os.Stderr, "       teardrop sync       upload your signed counts (time, prompts, tokens, lines; no text) to your account on the website")
		fmt.Fprintln(os.Stderr, "       teardrop submit     submit a project's hours with the full chat logs behind them, for review")
		fmt.Fprintln(os.Stderr, "       teardrop server     run the review server")
		fmt.Fprintln(os.Stderr, "       teardrop update     download the latest teardrop and replace this one with it")
		fmt.Fprintln(os.Stderr)
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() > 0 {
		// Without this, a mistyped command would quietly print the timeline.
		fmt.Fprintf(os.Stderr, "teardrop: unknown command %q\n\n", flag.Arg(0))
		flag.Usage()
		os.Exit(2)
	}
	if *showVersion {
		fmt.Println("teardrop", version)
		return
	}
	window, err := parseSince(*since)
	check(err)

	if live {
		if *asJSON {
			check(fmt.Errorf("-live redraws the screen, so it can't be combined with -json"))
		}
		runLive(*claudeDir, *codexDir, *since, window, rules, *every)
		return
	}

	raws, warnings := loadAll(*claudeDir, *codexDir)
	reportWarnings(warnings, *verbose)
	rep, sessions := buildReport(raws, time.Now().Add(-window), rules)
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		check(enc.Encode(rep))
		return
	}
	if len(rep.Blocks) == 0 {
		printEmpty(os.Stdout, *since, len(raws) > 0)
		return
	}
	printReport(os.Stdout, rep, len(sessions))
}

func printEmpty(out io.Writer, since string, anyLogs bool) {
	fmt.Fprintf(out, "No Claude Code, Codex, or Amp sessions found in the last %s.\n", since)
	if !anyLogs {
		fmt.Fprintln(out, "Run `teardrop setup` to see where teardrop looks for them.")
	} else {
		fmt.Fprintln(out, "Try a longer window, such as `teardrop -since 30d`.")
	}
}

// loadAll reads every transcript plus the hook journal.
func loadAll(claudeDir, codexDir string) ([]sources.Raw, []string) {
	return loadSince(claudeDir, codexDir, time.Time{})
}

// loadSince is loadAll without the transcripts last written before since.
func loadSince(claudeDir, codexDir string, since time.Time) ([]sources.Raw, []string) {
	raws, _, warnings := load(locations(claudeDir, codexDir), since)
	journal, jw := sources.ReadJournal(dataDir())
	return mergeJournal(raws, journal), append(warnings, jw...)
}

// lookups holds what a report learns about projects from git and their
// files: which project a log belongs to, the words in its files, and its
// commits. Live mode keeps one between refreshes, so git isn't asked and the
// files aren't reread every few seconds.
type lookups struct {
	// resolve names a log's project and the directory holding its files, if any.
	resolve func(sources.Raw) (timeline.Project, string)
	vocabs  map[string]textscore.Vocab // by project directory
	commits map[string]*commitLines    // by project directory, as read
}

func newLookups(resolve func(sources.Raw) (timeline.Project, string)) *lookups {
	return &lookups{resolve: resolve, vocabs: map[string]textscore.Vocab{}, commits: map[string]*commitLines{}}
}

// buildReport credits the events of raws after cutoff.
func buildReport(raws []sources.Raw, cutoff time.Time, rules timeline.Rules) (timeline.Report, []timeline.Session) {
	return buildReportWith(newLookups(localProjects()), raws, cutoff, rules)
}

func buildReportWith(look *lookups, raws []sources.Raw, cutoff time.Time, rules timeline.Rules) (timeline.Report, []timeline.Session) {
	sessions, committed := buildSessions(raws, cutoff, look)
	rep := timeline.Build(sessions, rules)
	for i := range rep.Projects {
		rep.Projects[i].Committed = committed[rep.Projects[i].Project.Key]
	}
	return rep, sessions
}

// buildSessions resolves each log to a project, keeps events after cutoff,
// marks prompts that fail the text check as noise, and finds the lines agents
// wrote that were later committed. It also returns the lines committed to
// each project's repository in the window.
func buildSessions(raws []sources.Raw, cutoff time.Time, look *lookups) ([]timeline.Session, map[string]int) {
	repos := map[string]*commitLines{} // this report's copies, which edits claim lines from
	committed := map[string]int{}
	var sessions []timeline.Session
	bar := newBar("Analyzing sessions", int64(len(raws)), "sessions")
	defer bar.done()
	for i, r := range raws {
		bar.set(int64(i))
		var p struct {
			project timeline.Project
			root    string
		}
		p.project, p.root = look.resolve(r)
		// Classify the whole session, so prompts before the window still count
		// as context for repeats and autopilot runs.
		all := slices.Clone(r.Events)
		discount(all, r.Scores, func(e timeline.Event, s textscore.Score) bool {
			if !e.Time.After(cutoff) {
				return false // outside the window: only context, so skip reading the repo
			}
			// Read the project's files only when a prompt has words the dictionary lacks.
			v, built := look.vocabs[p.root]
			if len(s.Unknown) > 0 && !built {
				v = textscore.RepoVocab(p.root)
				look.vocabs[p.root] = v
			}
			return s.Noise(v) > noiseThreshold
		})
		var ev []timeline.Event
		for i, e := range all {
			if !e.Time.After(cutoff) {
				continue
			}
			c := repos[p.root]
			if c == nil {
				read := look.commits[p.root]
				if read == nil {
					read = readCommits(p.root, cutoff)
					look.commits[p.root] = read
				}
				c = read.clone()
				repos[p.root] = c
				committed[p.project.Key] += c.added
			}
			if edit, ok := r.Edits[i]; ok {
				e.Kept = c.claim(edit.Hashes)
			}
			ev = append(ev, e)
		}
		if len(ev) > 0 {
			sessions = append(sessions, timeline.Session{Tool: r.Tool, ID: r.ID, Path: r.Path, Project: p.project, Events: ev})
		}
	}
	return sessions, committed
}

func printReport(out io.Writer, rep timeline.Report, nSessions int) {
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
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

	fmt.Fprintln(out)
	w = tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "PROJECT\tENGAGED\tSESSION TIME\tPROMPTS\tSKIPPED\tTOKENS IN/OUT\tAGENT LINES +/-\tKEPT\tCOMMITTED")
	skipped := 0
	for _, p := range rep.Projects {
		skipped += p.NoisePrompts + p.RepeatPrompts + p.AutopilotPrompts
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%d\t%s\t+%d/-%d\t%d\t%d\n", p.Project.Name, dur(time.Duration(p.Engaged)), dur(time.Duration(p.SessionTime)),
			p.Prompts, p.NoisePrompts+p.RepeatPrompts+p.AutopilotPrompts, tokens(p.In, p.Out), p.Lines.Added, p.Lines.Removed, p.Lines.Kept, p.Committed)
	}
	w.Flush()
	fmt.Fprintf(out, "\nTotal engaged: %s across %s and %s\n", dur(time.Duration(rep.Engaged)), plural(len(rep.Projects), "project"), plural(nSessions, "session"))
	if skipped > 0 {
		// Says that prompts were skipped, not which check skipped them.
		fmt.Fprintf(out, "%s earned no time (SKIPPED). Prompts that don't reflect real work aren't counted.\n", plural(skipped, "prompt"))
	}
	fmt.Fprintln(out, testingNotice)
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

// localProjects resolves logs to projects on this machine, asking git once per directory.
func localProjects() func(sources.Raw) (timeline.Project, string) {
	type resolved struct {
		project timeline.Project
		root    string
	}
	cache := map[string]resolved{}
	return func(r sources.Raw) (timeline.Project, string) {
		key := r.Cwd + "\x00" + r.GitURL
		p, ok := cache[key]
		if !ok {
			p.project, p.root = resolveProject(r.Cwd, r.GitURL)
			cache[key] = p
		}
		return p.project, p.root
	}
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
	return nameProject(root, gitURL), root
}

// nameProject names the project in the folder root by its git remote, when it has one.
func nameProject(root, gitURL string) timeline.Project {
	if gitURL != "" {
		key := normalizeRemote(gitURL)
		return timeline.Project{Key: key, Name: filepath.Base(key)}
	}
	if root == "" {
		return timeline.Project{Key: "(unknown)", Name: "(unknown)"}
	}
	return timeline.Project{Key: root, Name: filepath.Base(root)}
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
