package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

func TestSyncKeyGoesOnlyToItsServer(t *testing.T) {
	t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
	t.Setenv("TEARDROP_SERVER", "")
	t.Setenv("TEARDROP_KEY", "")
	var got string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
	}))
	defer ts.Close()

	// `teardrop sync -server ... -key ...` remembers both for later runs.
	srv, err := serverURL(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := syncKey("tdk_mine", srv); err != nil {
		t.Fatal(err)
	}
	srv, _ = serverURL("")
	key, _ := syncKey("", srv)
	if _, err := relayRequest(ts.Client(), "GET", srv+"/api/v1/whoami", key, nil, nil); err != nil || got != "Bearer tdk_mine" {
		t.Fatalf("a later sync sent Authorization %q (%v), want the remembered key", got, err)
	}

	t.Setenv("TEARDROP_SERVER", "https://elsewhere.example")
	srv, _ = serverURL("")
	if key, _ := syncKey("", srv); srv != "https://elsewhere.example" || key != "" {
		t.Errorf("$TEARDROP_SERVER: server %q got key %q, want none", srv, key)
	}
	t.Setenv("TEARDROP_SERVER", "")
	srv, _ = serverURL("https://new.example")
	if key, _ := syncKey("", srv); key != "" {
		t.Errorf("after switching servers, the new one got the old key %q", key)
	}
}

// `sync -dry-run` prints what a sync would send and changes nothing: no
// request, no stamp, and no remembered server or key.
func TestSyncDryRunSendsNothing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEARDROP_DATA_DIR", dir)
	t.Setenv("TEARDROP_SERVER", "")
	t.Setenv("TEARDROP_KEY", "")
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("dry run sent %s %s", r.Method, r.URL.Path)
	}))
	defer ts.Close()
	srv, _ := serverURL(ts.URL)
	syncKey("tdk_mine", srv)

	now := time.Now()
	stamp := filepath.Join(dir, "last-records")
	os.WriteFile(stamp, nil, 0o600)
	stampTime := now.Add(-3 * time.Hour)
	os.Chtimes(stamp, stampTime, stampTime)
	// One event after the stamp, which a sync sends, and one long before it, which it doesn't.
	sources.AppendJournal(dir, sources.JournalEvent{Time: now.Add(-time.Hour), Tool: "claude-code", Event: "UserPromptSubmit", Human: true, Session: "new-session"})
	sources.AppendJournal(dir, sources.JournalEvent{Time: now.Add(-48 * time.Hour), Tool: "claude-code", Event: "UserPromptSubmit", Human: true, Session: "old-session"})

	out, err := os.Create(filepath.Join(t.TempDir(), "out"))
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = out
	empty := t.TempDir()
	runSync([]string{"-dry-run", "-server", "https://elsewhere.example", "-key", "tdk_other", "-claude-dir", empty, "-codex-dir", empty})
	os.Stdout = stdout
	out.Close()

	got, _ := os.ReadFile(out.Name())
	if !strings.Contains(string(got), "new-session") || strings.Contains(string(got), "old-session") || strings.Count(string(got), "\n") != 1 {
		t.Errorf("dry run printed %q, want only the event after the last sync", got)
	}
	if info, _ := os.Stat(stamp); !info.ModTime().Equal(stampTime) {
		t.Error("dry run moved the last-records stamp")
	}
	if s, _ := serverURL(""); s != srv {
		t.Errorf("dry run remembered server %q, want %q", s, srv)
	}
	if k, _ := syncKey("", srv); k != "tdk_mine" {
		t.Errorf("dry run remembered key %q", k)
	}
}

// A sync says when the site refused records as dated in its future, and
// warns when this computer's clock is off by enough to lose time.
func TestSyncWarnsAboutTheClock(t *testing.T) {
	cases := []struct {
		name  string
		skew  time.Duration // how far this computer's clock is ahead of the site's
		whoam bool          // whether the site answers whoami
		want  []string
		not   []string
	}{
		{"slow clock", -10 * time.Minute, true, []string{"10 minutes behind the site's", "refused 2 records"}, []string{"ahead of the site's"}},
		{"fast clock", 7 * time.Minute, true, []string{"7 minutes ahead of the site's"}, []string{"behind the site's"}},
		{"right clock", 30 * time.Second, true, nil, []string{"Your clock"}},
		{"site without whoami", -10 * time.Minute, false, nil, []string{"Your clock"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("TEARDROP_DATA_DIR", dir)
			t.Setenv("TEARDROP_SERVER", "")
			t.Setenv("TEARDROP_KEY", "")
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/events":
					// The site measures the clock from when the batch says it was sent.
					if sent, err := time.Parse(time.RFC3339Nano, r.Header.Get("X-Teardrop-Sent-At")); err != nil || time.Since(sent).Abs() > time.Minute {
						t.Errorf("X-Teardrop-Sent-At was %q", r.Header.Get("X-Teardrop-Sent-At"))
					}
					w.Write([]byte(`{"stored":0,"records":1,"dropped_future":2}`))
				case "/api/v1/whoami":
					if !c.whoam {
						http.NotFound(w, r)
						return
					}
					fmt.Fprintf(w, `{"name":"Ada","time":%q}`, time.Now().Add(-c.skew).Format(time.RFC3339Nano))
				default:
					w.Write([]byte("{}"))
				}
			}))
			defer ts.Close()
			sources.AppendJournal(dir, sources.JournalEvent{Time: time.Now().Add(-time.Minute), Tool: "claude-code", Event: "UserPromptSubmit", Human: true, Session: "s"})

			out, err := os.Create(filepath.Join(t.TempDir(), "out"))
			if err != nil {
				t.Fatal(err)
			}
			stdout := os.Stdout
			os.Stdout = out
			empty := t.TempDir()
			runSync([]string{"-server", ts.URL, "-key", "tdk_k", "-claude-dir", empty, "-codex-dir", empty})
			os.Stdout = stdout
			out.Close()
			got, _ := os.ReadFile(out.Name())
			for _, w := range c.want {
				if !strings.Contains(string(got), w) {
					t.Errorf("sync printed %q, want %q in it", got, w)
				}
			}
			for _, n := range c.not {
				if strings.Contains(string(got), n) {
					t.Errorf("sync printed %q, want no %q", got, n)
				}
			}
		})
	}
}

func TestSyncQueued(t *testing.T) {
	dir := t.TempDir()
	lock, note := filepath.Join(dir, "sync.lock"), filepath.Join(dir, "sync-wanted")
	runs := 0
	// A turn ends while the first sync runs: it goes once more, then stops.
	err := syncQueued(dir, func() error {
		if runs++; runs == 1 {
			if _, err := os.Stat(lock); err != nil {
				t.Error("no lock was held while syncing")
			}
			os.WriteFile(note, nil, 0o600)
			ended := time.Now().Add(20 * time.Millisecond)
			os.Chtimes(note, ended, ended)
			time.Sleep(40 * time.Millisecond)
		}
		return nil
	})
	if err != nil || runs != 2 {
		t.Errorf("a turn ended during a sync: %d runs and err %v, want 2 and none", runs, err)
	}
	// With the note older than the sync, one run is enough.
	if runs = 0; syncQueued(dir, func() error { runs++; return nil }) != nil || runs != 1 {
		t.Errorf("nothing ended during the sync: %d runs, want 1", runs)
	}

	// While another sync holds the lock, this one leaves it to that one, and
	// says so, so it doesn't clear that sync's kept error.
	os.WriteFile(lock, nil, 0o600)
	if runs = 0; !errors.Is(syncQueued(dir, func() error { runs++; return nil }), errSyncBusy) || runs != 0 {
		t.Errorf("another sync was running: %d runs, want none", runs)
	}
	// A lock left by a sync that died is taken over.
	long := time.Now().Add(-2 * syncLockStale)
	os.Chtimes(lock, long, long)
	failed := errors.New("no network")
	if err := syncQueued(dir, func() error { runs++; return failed }); err != failed || runs != 1 {
		t.Errorf("a stale lock: %d runs and err %v, want 1 and the sync's error", runs, err)
	}
	if _, err := os.Stat(lock); err == nil {
		t.Error("a failed sync left its lock behind")
	}
}
