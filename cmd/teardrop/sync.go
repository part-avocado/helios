package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
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
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/timeline"
)

const (
	// syncWindow is how much history a sync uploads.
	syncWindow = "365d"
	// syncEvery is how often hooks start a background sync while no turn
	// ends, such as at a prompt. A turn that ends starts one at once.
	syncEvery = 15 * time.Minute
	// A background sync that has run this long is taken to have died. An
	// upload alone may take five minutes.
	syncLockStale = 10 * time.Minute
)

// submittedLog names one log in a submission; the signature covers its hash,
// so the log can't be swapped after signing.
type submittedLog struct {
	Tool   string `json:"tool"` // claude-code, codex, or journal
	ID     string `json:"id"`
	SHA256 string `json:"sha256"`
}

type submissionPayload struct {
	Kind        string           `json:"kind"` // "submission"
	Account     string           `json:"account"`
	GeneratedAt time.Time        `json:"generated_at"`
	ExpiresAt   time.Time        `json:"expires_at"`
	Since       string           `json:"since"`
	Teardrop    string           `json:"teardrop_version"`
	Project     timeline.Project `json:"project"`
	Report      timeline.Report  `json:"report"` // this project's blocks and total only
	Logs        []submittedLog   `json:"logs"`
}

// Submission is a project's signed hours plus the full logs behind them:
// prompts, replies, and code changes, for reviewers.
type Submission struct {
	Signed SignedReport `json:"signed"`
	Logs   [][]byte     `json:"logs"` // contents of the logs Payload lists, in order
}

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
		return "", errors.New("no server set; sign in on your teardrop site and run the command under Settings, or run `teardrop sync -server https://...` once")
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
	fs.Parse(args)
	srv, err := serverURL(*server)
	check(err)
	k, err := syncKey(*key, srv)
	check(err)

	var rep timeline.Report
	var res []byte
	once := func() error {
		window, _ := parseSince(syncWindow)
		now := time.Now()
		raws, _ := loadAll(*claudeDir, *codexDir)
		rep, _ = buildReport(raws, now.Add(-window), timeline.DefaultRules)
		signed, err := signReport(rep, syncWindow, now)
		if err != nil {
			return err
		}
		b, err := json.Marshal(signed)
		if err != nil {
			return err
		}
		if res, err = post(srv, k, "/api/v1/reports", b); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dataDir(), "last-sync"), nil, 0o600)
	}
	if *background {
		check(syncQueued(dataDir(), once))
		return
	}
	check(once())
	if *quiet {
		return
	}
	priv, _ := accountKey()
	id := accountID(priv.Public().(ed25519.PublicKey))
	// A server with accounts answers with the page that shows these stats.
	var r struct {
		URL string `json:"url"`
	}
	json.Unmarshal(res, &r)
	if r.URL == "" {
		r.URL = srv + "/api/v1/accounts/" + id
	}
	fmt.Printf("Synced %s engaged across %s from this computer (%s).\nSee it at %s\n",
		dur(time.Duration(rep.Engaged)), plural(len(rep.Projects), "project"), id, r.URL)
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

// runSubmit uploads one project's hours with the full chat logs behind them.
func runSubmit(args []string) {
	fs := flag.NewFlagSet("submit", flag.ExitOnError)
	since := fs.String("since", "365d", "only count events newer than this")
	out := fs.String("o", "", "write the submission to this file instead of uploading it")
	server := fs.String("server", "", "central server URL, remembered for later runs")
	yes := fs.Bool("yes", false, "upload without asking")
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: teardrop submit [flags] <project>")
		fs.PrintDefaults()
	}
	projects := parseAnywhere(fs, args)
	if len(projects) != 1 {
		fs.Usage()
		os.Exit(2)
	}
	window, err := parseSince(*since)
	check(err)

	now := time.Now()
	raws, _ := loadAll(*claudeDir, *codexDir)
	rep, sessions := buildReport(raws, now.Add(-window), timeline.DefaultRules)
	key, err := pickProject(rep, projects[0])
	check(err)
	sub, err := makeSubmission(key, rep, sessions, *since, now)
	check(err)
	b, err := json.Marshal(sub)
	check(err)

	var p submissionPayload
	json.Unmarshal([]byte(sub.Signed.Payload), &p)
	fmt.Fprintf(os.Stderr, "%s: %s engaged in %s, backed by %s (%.1f MB).\n", p.Project.Name,
		dur(time.Duration(p.Report.Engaged)), plural(len(p.Report.Blocks), "block"), plural(len(p.Logs), "chat log"), float64(len(b))/1e6)
	if *out != "" {
		check(os.WriteFile(*out, append(b, '\n'), 0o600))
		fmt.Fprintf(os.Stderr, "Wrote %s. It holds your full prompts, the agent's replies, and its code changes.\n", *out)
		return
	}
	srv, err := serverURL(*server)
	check(err)
	if !*yes {
		fmt.Fprintf(os.Stderr, "This uploads those chat logs to %s for review: your full prompts, the agent's replies,\n"+
			"and its code changes, including anything secret you pasted into a chat. Upload? [y/N] ", srv)
		ans, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(ans)); a != "y" && a != "yes" {
			fmt.Fprintln(os.Stderr, "Nothing was uploaded. Use -o to write the file and read it first.")
			os.Exit(1)
		}
	}
	k, err := syncKey("", srv)
	check(err)
	res, err := post(srv, k, "/api/v1/submissions", b)
	check(err)
	var r struct {
		ID string `json:"id"`
	}
	json.Unmarshal(res, &r)
	fmt.Printf("Submitted as %s.\n", r.ID)
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

// makeSubmission signs project key's part of rep together with the logs of
// its sessions.
func makeSubmission(key string, rep timeline.Report, sessions []timeline.Session, since string, now time.Time) (Submission, error) {
	var mine timeline.Report
	for _, b := range rep.Blocks {
		if b.Project.Key == key {
			mine.Blocks = append(mine.Blocks, b)
		}
	}
	var project timeline.Project
	for _, p := range rep.Projects {
		if p.Project.Key == key {
			mine.Projects, mine.Engaged, project = []timeline.ProjectTotal{p}, p.Engaged, p.Project
		}
	}
	var sub Submission
	var logs []submittedLog
	seen := map[string]bool{}
	for _, s := range sessions {
		if s.Project.Key != key || seen[s.Path] {
			continue
		}
		seen[s.Path] = true
		tool := s.Tool
		var data []byte
		var err error
		if strings.Contains(s.Path, ".jsonl#") { // read from the hook journal, not a transcript
			tool, data = "journal", sources.JournalLines(dataDir(), s.Tool, s.ID)
		} else if data, err = sources.ReadLog(s.Path); err != nil {
			return sub, fmt.Errorf("reading %s: %w", s.Path, err)
		}
		sum := sha256.Sum256(data)
		logs = append(logs, submittedLog{Tool: tool, ID: s.ID, SHA256: hex.EncodeToString(sum[:])})
		sub.Logs = append(sub.Logs, data)
	}
	signed, err := signPayload(func(account string) any {
		return submissionPayload{
			Kind: "submission", Account: account,
			GeneratedAt: now.UTC(), ExpiresAt: now.UTC().Add(keyLifetime),
			Since: since, Teardrop: version, Project: project, Report: mine, Logs: logs,
		}
	})
	sub.Signed = signed
	return sub, err
}
