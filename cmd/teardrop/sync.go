package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
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

// checkServer returns -server's URL without a trailing slash, or why it isn't one.
func checkServer(set string) (string, error) {
	u, err := url.Parse(set)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", fmt.Errorf("-server %q: use a URL such as https://teardrop.example.org", set)
	}
	return strings.TrimRight(set, "/"), nil
}

// serverURL returns the central server: -server (remembered for later
// runs), else $TEARDROP_SERVER, else the remembered one.
func serverURL(set string) (string, error) {
	path := filepath.Join(dataDir(), "server")
	if set != "" {
		s, err := checkServer(set)
		if err != nil {
			return "", err
		}
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
		if errors.Is(err, errSyncBusy) {
			err = nil // the running sync keeps its own outcome
		} else {
			keepError("sync", err)
		}
		exe, _ := teardropPath()
		checkForUpdate(&http.Client{Timeout: 5 * time.Minute}, releasesURL, exe)
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
	ran := false
	lock := filepath.Join(dir, "sync.lock")
	for i := 0; i < 5; i++ {
		if info, err := os.Stat(lock); err == nil && time.Since(info.ModTime()) > syncLockStale {
			os.Remove(lock)
		}
		f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			if ran {
				return nil
			}
			return errSyncBusy // another sync is running, and will see the note
		}
		f.Close()
		ran = true
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

// errSyncBusy is syncQueued finding another sync running, which then syncs for it.
var errSyncBusy = errors.New("another sync is running")

// syncSoon starts a background sync when a server is set. With now, because
// a turn just ended, it starts one at once. Otherwise it starts one only if
// the last was more than syncEvery ago. Hooks call it, so it never waits.
func syncSoon(now bool) {
	if !siteSet() {
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
	// Only one process at a time reads and writes the stamp, so two that
	// start at once don't both find it due. A lock left by one that died
	// is taken over after a minute.
	lock := stamp + ".lock"
	// One dated over a minute ahead, from before the clock was set back, is stale too.
	if info, err := os.Stat(lock); err == nil && (time.Since(info.ModTime()) > time.Minute || time.Since(info.ModTime()) < -time.Minute) {
		os.Remove(lock)
	}
	f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false // another is deciding now
	}
	f.Close()
	defer os.Remove(lock)
	if info, err := os.Stat(stamp); err == nil && time.Since(info.ModTime()) < every {
		return false
	}
	os.WriteFile(stamp, nil, 0o600)
	return true
}

// parseAnywhere parses flags that come before or after the other arguments,
// which it returns, so a flag may follow them.
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
