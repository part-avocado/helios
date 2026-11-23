package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/timeline"
)

const (
	// syncWindow is how much history the first sync sends.
	syncWindow = "365d"
	// syncEvery is how often hooks start a background sync while no turn
	// ends, such as at a prompt. A turn that ends starts one at once.
	syncEvery = 15 * time.Minute
	// A background sync that has run this long is taken to have died. An
	// upload alone may take five minutes.
	syncLockStale = 10 * time.Minute
)

// serverURL returns the central server: -server (remembered for later
// runs), else $TEARDROP_SERVER, else the remembered one.
func serverURL(set string) (string, error) {
	path := filepath.Join(dataDir(), "server")
	if set != "" {
		u, err := url.Parse(set)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return "", fmt.Errorf("-server %q: use a URL such as https://teardrop.example.org", set)
		}
		s := strings.TrimRight(set, "/")
		if err := os.MkdirAll(dataDir(), 0o700); err != nil {
			return "", err
		}
		if old, _ := os.ReadFile(path); strings.TrimSpace(string(old)) != s {
			os.Remove(keyPath()) // the remembered key belongs to the old server
		}
		return s, os.WriteFile(path, []byte(s+"\n"), 0o600)
	}
	if s := os.Getenv("TEARDROP_SERVER"); s != "" {
		return strings.TrimRight(s, "/"), nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("no server set; run `teardrop login -server https://your-site` once")
	}
	return strings.TrimSpace(string(b)), nil
}

func keyPath() string { return filepath.Join(dataDir(), "key") }

// syncKey returns the key that says whose account on server this computer
// syncs to: -key (remembered for later runs), else $TEARDROP_KEY, else the
// remembered one. It is "" for a server without accounts.
func syncKey(set, server string) (string, error) {
	if set != "" {
		if err := os.MkdirAll(dataDir(), 0o700); err != nil {
			return "", err
		}
		return set, os.WriteFile(keyPath(), []byte(set+"\n"), 0o600)
	}
	if k := os.Getenv("TEARDROP_KEY"); k != "" {
		return k, nil
	}
	// The remembered key goes only to the remembered server, never to one
	// named by $TEARDROP_SERVER.
	if remembered, _ := os.ReadFile(filepath.Join(dataDir(), "server")); strings.TrimSpace(string(remembered)) != server {
		return "", nil
	}
	b, _ := os.ReadFile(keyPath())
	return strings.TrimSpace(string(b)), nil
}

// post sends body to the server, with the sync key if there is one.
func post(server, key, path string, body []byte) ([]byte, error) {
	bar := newBar("Uploading", int64(len(body)), "bytes")
	defer bar.done()
	req, err := http.NewRequest("POST", server+path, &progressReader{r: bytes.NewReader(body), b: bar})
	if err != nil {
		return nil, err
	}
	// A custom reader hides the size and the way to resend the body after a redirect.
	req.ContentLength = int64(len(body))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Teardrop-Version", version)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	c := &http.Client{Timeout: 5 * time.Minute}
	res, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("server said %s: %s", res.Status, strings.TrimSpace(string(b)))
	}
	return b, nil
}

// runSync uploads this machine's signed counts to the server: time blocks,
// prompt counts, tokens, and line counts. It never uploads prompt text.
func runSync(args []string) {
	fs := flag.NewFlagSet("sync", flag.ExitOnError)
	server := fs.String("server", "", "central server URL, remembered for later runs")
	key := fs.String("key", "", "your sync key from the server's Settings page, remembered for later runs")
	quiet := fs.Bool("quiet", false, "print only errors (used by hooks)")
	background := fs.Bool("background", false, "do nothing while another background sync runs, and sync again if a turn ended meanwhile (used by hooks)")
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	dryRun := fs.Bool("dry-run", false, "print the records a sync would send, as JSON lines, and send nothing")
	fs.Parse(args)
	if *dryRun {
		// Before serverURL and syncKey, which remember -server and -key.
		_, _, body, n, err := pendingRecords(*claudeDir, *codexDir, false)
		check(err)
		os.Stdout.Write(body)
		fmt.Fprintf(os.Stderr, "A sync would send %s. Nothing was sent.\n", plural(n, "record"))
		return
	}
	srv, err := serverURL(*server)
	check(err)
	k, err := syncKey(*key, srv)
	check(err)

	sent, total, future := 0, 0, 0
	once := func() error {
		now := time.Now()
		stamp := filepath.Join(dataDir(), "last-records")
		transcripts, journal, body, n, err := pendingRecords(*claudeDir, *codexDir, true)
		if err != nil {
			return err
		}
		header, err := computerHeader()
		if err != nil {
			return err
		}
		total = n
		sent, future, err = sendRecords(&http.Client{Timeout: 2 * time.Minute}, srv, k, body, header)
		if err != nil {
			return err
		}
		// Commits go with the records, which `teardrop relay` sends.
		if queueCommits(mergeJournal(transcripts, journalRaws(journal)), now) > 0 {
			relaySoon(false)
		}
		os.WriteFile(stamp, nil, 0o600)
		return os.WriteFile(filepath.Join(dataDir(), "last-sync"), nil, 0o600)
	}
	if *background {
		err := syncQueued(dataDir(), once)
		keepError("sync", err)
		checkForUpdate(&http.Client{Timeout: 10 * time.Second}, releasesURL)
		check(err)
		return
	}
	err = once()
	keepError("sync", err)
	check(err)
	if *quiet {
		return
	}
	// A site from before whoami answers 404; then there is nothing to compare.
	// With nothing to send, whoami is the one call that hears the site
	// refuse this version.
	who, status, whoErr := whoami(&http.Client{Timeout: 10 * time.Second}, srv, k)
	if status == http.StatusUpgradeRequired {
		check(whoErr)
	}
	id, _ := thisComputer()
	fmt.Printf("Sent %s from this computer (%s); %d were new to the site.\n", plural(total, "record"), id, sent)
	if future > 0 {
		fmt.Printf("The site refused %s dated more than 5 minutes ahead of its clock.\n", plural(future, "record"))
	}
	if whoErr == nil {
		if w := clockWarning(who.Skew); w != "" {
			fmt.Println(w)
		}
	}
	fmt.Printf("See it at %s/dashboard\n", srv)
}

// pendingRecords is what the next sync sends, as JSON lines: after the
// first run, only what changed since the last one, with an hour to spare.
// The site drops a record it already has. With saveWords, it first saves the
// words of recent projects' files (vocab.go), which a dry run leaves alone.
func pendingRecords(claudeDir, codexDir string, saveWords bool) (transcripts []sources.Raw, journal []sources.JournalEvent, body []byte, n int, err error) {
	window, _ := parseSince(syncWindow)
	cutoff := time.Now().Add(-window)
	if info, err := os.Stat(filepath.Join(dataDir(), "last-records")); err == nil && info.ModTime().After(cutoff) {
		cutoff = info.ModTime().Add(-time.Hour)
	}
	transcripts, _, _ = load(locations(claudeDir, codexDir), cutoff)
	journal = sources.ReadJournalEvents(dataDir(), cutoff.Add(-24*time.Hour))
	resolve := localProjects()
	if saveWords {
		saveVocabs(recentRoots(transcripts, journal, resolve, time.Now()))
	}
	recs := syncRecords(transcripts, journal, resolve, cutoff)
	var buf bytes.Buffer
	for _, r := range recs {
		b, err := json.Marshal(r)
		if err != nil {
			return nil, nil, nil, 0, err
		}
		buf.Write(append(b, '\n'))
	}
	return transcripts, journal, buf.Bytes(), len(recs), nil
}

// journalRaws gives each journal session's folder, for finding its repository.
func journalRaws(journal []sources.JournalEvent) []sources.Raw {
	seen := map[string]bool{}
	var out []sources.Raw
	for _, ev := range journal {
		if k := ev.Tool + "\x00" + ev.Session; !seen[k] {
			seen[k] = true
			out = append(out, sources.Raw{Tool: ev.Tool, ID: ev.Session, Cwd: ev.Cwd, GitURL: ev.Git})
		}
	}
	return out
}

// syncQueued runs sync for a hook, in dir. Only one runs at a time on a
// machine: two at once would upload the same report twice, and the server
// refuses the one that arrives second. A turn that ends while one runs is not
// lost: its hook leaves a note in dir (sync-wanted), and the sync that is
// running goes again once it is done.
func syncQueued(dir string, sync func() error) error {
	lock := filepath.Join(dir, "sync.lock")
	for i := 0; i < 5; i++ {
		if info, err := os.Stat(lock); err == nil && time.Since(info.ModTime()) > syncLockStale {
			os.Remove(lock)
		}
		f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return nil // another sync is running, and will see the note
		}
		f.Close()
		started := time.Now()
		err = sync()
		os.Remove(lock)
		if err != nil {
			return err
		}
		if note, err := os.Stat(filepath.Join(dir, "sync-wanted")); err != nil || !note.ModTime().After(started) {
			return nil
		}
	}
	return nil
}

// syncSoon starts a background sync when a server is set. With now, because
// a turn just ended, it starts one at once. Otherwise it starts one only if
// the last was more than syncEvery ago. Hooks call it, so it never waits.
func syncSoon(now bool) {
	if _, err := os.Stat(filepath.Join(dataDir(), "server")); err != nil {
		return
	}
	if now {
		// For a sync that is already running: it started before this turn ended.
		os.WriteFile(filepath.Join(dataDir(), "sync-wanted"), nil, 0o600)
	} else if !due(filepath.Join(dataDir(), "last-sync"), syncEvery) {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	logf, _ := os.OpenFile(filepath.Join(dataDir(), "sync.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	cmd := exec.Command(exe, "sync", "-quiet", "-background")
	cmd.Stdout, cmd.Stderr = logf, logf
	detach(cmd)
	if cmd.Start() == nil {
		cmd.Process.Release()
	}
	if logf != nil {
		logf.Close()
	}
}

// due reports whether the run that stamp records is more than every old, or
// there was none. If so it records one now, so parallel hooks start one run.
func due(stamp string, every time.Duration) bool {
	if info, err := os.Stat(stamp); err == nil && time.Since(info.ModTime()) < every {
		return false
	}
	os.WriteFile(stamp, nil, 0o600)
	return true
}

// runSubmit asks the site to submit one project. The site makes the
// submission from the records it already holds, so nothing is uploaded: no
// logs, no prompts. The project is named by key or name, as this computer
// knows it.
func runSubmit(args []string) {
	fs := flag.NewFlagSet("submit", flag.ExitOnError)
	since := fs.String("since", "365d", "where to look for the project's name")
	server := fs.String("server", "", "central server URL, remembered for later runs")
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	note := fs.String("note", "", "a note for the reviewers, such as what the project is or why some time arrived late")
	list := fs.Bool("list", false, "list your submissions and how each was decided, instead of submitting")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: teardrop submit [flags] <project>")
		fmt.Fprintln(os.Stderr, "       teardrop submit -list")
		fs.PrintDefaults()
	}
	projects := parseAnywhere(fs, args)
	if *list {
		srv, err := serverURL(*server)
		check(err)
		k, err := syncKey("", srv)
		check(err)
		check(listSubmissions(&http.Client{Timeout: 30 * time.Second}, srv, k, os.Stdout))
		return
	}
	if len(projects) != 1 {
		fs.Usage()
		os.Exit(2)
	}
	key := projects[0]
	if window, err := parseSince(*since); err == nil {
		raws, _ := loadAll(*claudeDir, *codexDir)
		rep, _ := buildReport(raws, time.Now().Add(-window), timeline.DefaultRules)
		if k, err := pickProject(rep, projects[0]); err == nil {
			key = k
		}
	}
	srv, err := serverURL(*server)
	check(err)
	k, err := syncKey("", srv)
	check(err)
	body, _ := json.Marshal(map[string]string{"project": key, "note": *note})
	res, err := post(srv, k, "/api/v1/submissions", body)
	check(err)
	var r struct {
		ID         string `json:"id"`
		Witnessed  int64  `json:"witnessed_seconds"`
		Unwitness  int64  `json:"unwitnessed_seconds"`
		Credited   int64  `json:"credited_seconds"`
		Overlapped int64  `json:"earlier_overlap_seconds"`
	}
	check(json.Unmarshal(res, &r))
	fmt.Printf("Submitted %s as %s.\n", key, r.ID)
	fmt.Printf("  %s witnessed by the site, %s credited", dur(time.Duration(r.Witnessed)*time.Second), dur(time.Duration(r.Credited)*time.Second))
	if r.Overlapped > 0 {
		fmt.Printf(" (%s was in earlier submissions)", dur(time.Duration(r.Overlapped)*time.Second))
	}
	fmt.Println(".")
	if r.Unwitness > 0 {
		fmt.Printf("  %s reached the site late, such as from before teardrop's hooks were set up, and is not credited unless a reviewer accepts it.\n", dur(time.Duration(r.Unwitness)*time.Second))
	}
}

// listSubmissions prints the person's submissions, newest first, with what
// each credited and, once a reviewer has approved, adjusted, or rejected it,
// what it finally credits and why.
func listSubmissions(client *http.Client, srv, key string, out io.Writer) error {
	var r struct {
		Submissions []struct {
			Project       string `json:"project_name"`
			Received      int64  `json:"received_at"`
			Credited      int64  `json:"credited_seconds"`
			Unwitnessed   int64  `json:"unwitnessed_seconds"`
			Accepted      int64  `json:"accepted_seconds"`
			Final         *int64 `json:"final_seconds"`
			State         string `json:"state"`
			Decided       *int64 `json:"decided_at"`
			Note          string `json:"note"`
			SubmitterNote string `json:"submitter_note"`
		} `json:"submissions"`
	}
	if _, err := relayRequest(client, "GET", srv+"/api/v1/submissions", key, nil, &r); err != nil {
		return err
	}
	if len(r.Submissions) == 0 {
		fmt.Fprintln(out, "No submissions yet. Run `teardrop submit <project>` to make one.")
		return nil
	}
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SUBMITTED\tPROJECT\tCREDITED\tUNWITNESSED\tACCEPTED\tFINAL\tSTATE")
	for _, s := range r.Submissions {
		state, final := "waiting for review", "-"
		if s.Final != nil {
			state, final = s.State, dur(time.Duration(*s.Final)*time.Second)
			if s.Decided != nil {
				state += " " + time.UnixMilli(*s.Decided).Format("Jan 2")
			}
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", time.UnixMilli(s.Received).Format("Jan 2 15:04"), s.Project,
			dur(time.Duration(s.Credited)*time.Second), dur(time.Duration(s.Unwitnessed)*time.Second), dur(time.Duration(s.Accepted)*time.Second), final, state)
	}
	w.Flush()
	var notes []string
	for _, s := range r.Submissions {
		if s.SubmitterNote != "" {
			notes = append(notes, fmt.Sprintf("%s, %s, your note: %s", s.Project, time.UnixMilli(s.Received).Format("Jan 2"), s.SubmitterNote))
		}
		if s.Note != "" {
			notes = append(notes, fmt.Sprintf("%s, %s, the reviewer's note: %s", s.Project, time.UnixMilli(s.Received).Format("Jan 2"), s.Note))
		}
	}
	if len(notes) > 0 {
		fmt.Fprintln(out, "\n"+strings.Join(notes, "\n"))
	}
	return nil
}

// parseAnywhere parses flags that come before or after the other arguments,
// which it returns, so `teardrop submit myproject -yes` works.
func parseAnywhere(fs *flag.FlagSet, args []string) []string {
	var rest []string
	for {
		fs.Parse(args)
		if fs.NArg() == 0 {
			return rest
		}
		rest = append(rest, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

// pickProject finds the project named arg, by key or name.
func pickProject(rep timeline.Report, arg string) (string, error) {
	var keys, names []string
	for _, p := range rep.Projects {
		names = append(names, p.Project.Name)
		if p.Project.Key == arg || strings.EqualFold(p.Project.Name, arg) {
			keys = append(keys, p.Project.Key)
		}
	}
	switch len(keys) {
	case 1:
		return keys[0], nil
	case 0:
		return "", fmt.Errorf("no project %q in this window; projects: %s", arg, strings.Join(names, ", "))
	}
	return "", fmt.Errorf("%q names several projects; use one of: %s", arg, strings.Join(keys, ", "))
}
