package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Each state a computer can be in gets the finding that says so, and doctor
// fails exactly when something loses time.
func TestDoctor(t *testing.T) {
	type state struct {
		whoami   func(w http.ResponseWriter) // the site's answer; nil for no site set
		hookExe  string                      // what the Claude Code hook runs: "here" for a file that exists, "" for no hooks
		queued   int
		lastErr  bool
		name     string
		level    int
		detail   string
		failsDoc bool
	}
	at := func(skew time.Duration) func(w http.ResponseWriter) {
		return func(w http.ResponseWriter) {
			fmt.Fprintf(w, `{"name":"Ada","handle":"ada","time":%q}`, time.Now().Add(-skew).Format(time.RFC3339Nano))
		}
	}
	refuse := func(code int, msg string) func(w http.ResponseWriter) {
		return func(w http.ResponseWriter) { http.Error(w, msg, code) }
	}
	good := state{whoami: at(0), hookExe: "here"}
	with := func(f func(*state)) state { s := good; f(&s); return s }
	cases := []state{
		with(func(s *state) { s.name, s.level, s.detail = "Site", levelOK, "signed in as Ada (@ada)" }),
		with(func(s *state) { s.name, s.level, s.detail = "Claude Code hooks", levelOK, "installed" }),
		with(func(s *state) {
			s.whoami, s.name, s.level, s.detail, s.failsDoc = nil, "Site", levelFix, "no server set", true
		}),
		with(func(s *state) {
			s.whoami, s.name, s.level, s.detail, s.failsDoc = refuse(401, "This server needs your sync key."), "Site", levelFix, "does not know this computer's sync key", true
		}),
		with(func(s *state) {
			s.whoami, s.name, s.level, s.detail, s.failsDoc = refuse(403, "You are banned until a reviewer lifts it."), "Site", levelFix, "You are banned until a reviewer lifts it.", true
		}),
		with(func(s *state) {
			s.whoami, s.name, s.level, s.detail = refuse(404, "Not found"), "Site", levelNote, "older than this helios"
		}),
		with(func(s *state) {
			s.whoami, s.name, s.level, s.detail, s.failsDoc = refuse(426, "This site needs helios v0.6.0 or newer."), "Site", levelFix, "This site needs helios v0.6.0 or newer.", true
		}),
		with(func(s *state) {
			s.whoami, s.name, s.level, s.detail, s.failsDoc = at(-9*time.Minute), "Clock", levelFix, "9 minutes behind", true
		}),
		with(func(s *state) { s.whoami, s.name, s.level, s.detail = at(40*time.Second), "Clock", levelOK, "matches" }),
		with(func(s *state) {
			s.hookExe, s.name, s.level, s.detail, s.failsDoc = "", "Claude Code hooks", levelFix, "not installed", true
		}),
		with(func(s *state) {
			s.hookExe, s.name, s.level, s.detail, s.failsDoc = "/gone/helios", "Claude Code hooks", levelFix, "/gone/helios, which is no longer there", true
		}),
		with(func(s *state) {
			s.queued, s.name, s.level, s.detail = 3, "Waiting", levelNote, "3 records not sent yet"
		}),
		// Past this, queueRelay keeps no new records, so time is lost until it is sent.
		with(func(s *state) {
			s.queued, s.name, s.level, s.detail, s.failsDoc = maxOutboxBytes/3+1, "Outbox", levelFix, "full, so new records are not being kept", true
		}),
		with(func(s *state) {
			s.lastErr, s.name, s.level, s.detail, s.failsDoc = true, "Last error", levelFix, "sync failed", true
		}),
	}
	for _, c := range cases {
		t.Run(c.name+": "+c.detail, func(t *testing.T) {
			root := t.TempDir()
			data, claude := filepath.Join(root, "data"), filepath.Join(root, "claude")
			os.MkdirAll(data, 0o700)
			os.MkdirAll(claude, 0o700)
			t.Setenv("HOME", root)
			t.Setenv("USERPROFILE", root)
			t.Setenv("XDG_CONFIG_HOME", root)
			t.Setenv("HELIOS_DATA_DIR", data)
			t.Setenv("CLAUDE_CONFIG_DIR", claude)
			t.Setenv("CODEX_HOME", filepath.Join(root, "no-codex"))
			t.Setenv("HELIOS_SERVER", "")
			t.Setenv("HELIOS_KEY", "")
			for _, v := range []string{"HELIOS_CLOUD", "CLAUDE_CODE_REMOTE", "CODESPACES"} {
				t.Setenv(v, "") // the tests may themselves run in a cloud session
			}
			t.Setenv("PATH", "") // so the Amp CLI, if this machine has one, is not found

			if c.whoami != nil {
				ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/api/v1/whoami" && r.Header.Get("Authorization") == "Bearer tdk_secret" {
						c.whoami(w)
						return
					}
					http.NotFound(w, r)
				}))
				defer ts.Close()
				os.WriteFile(filepath.Join(data, "server"), []byte(ts.URL+"\n"), 0o600)
				os.WriteFile(filepath.Join(data, "key"), []byte("tdk_secret\n"), 0o600)
			}
			exe := c.hookExe
			if exe == "here" {
				exe = filepath.ToSlash(filepath.Join(root, "helios"))
				os.WriteFile(exe, nil, 0o700)
			}
			if exe != "" {
				settings, _ := json.Marshal(map[string]any{"hooks": map[string]any{"Stop": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": `"` + exe + `" hook claude-code`}}}}}})
				os.WriteFile(filepath.Join(claude, "settings.json"), settings, 0o600)
			}
			if c.queued > 0 {
				os.WriteFile(filepath.Join(data, localOutbox), bytes.Repeat([]byte("{}\n"), c.queued), 0o600)
			}
			if c.lastErr {
				keepError("sync", errors.New("server said 500"))
			}

			findings := diagnose("", "", &http.Client{Timeout: 5 * time.Second}, "http://127.0.0.1:1")
			var got *finding
			for i := range findings {
				if findings[i].Name == c.name {
					got = &findings[i]
				}
			}
			if got == nil || got.Level != c.level || !strings.Contains(got.Detail, c.detail) {
				t.Fatalf("got %+v, want %s at level %d with %q in %+v", got, c.name, c.level, c.detail, findings)
			}
			var out bytes.Buffer
			if failed := printDoctor(&out, findings); failed != c.failsDoc {
				t.Errorf("doctor failed = %v, want %v:\n%s", failed, c.failsDoc, &out)
			}
			if strings.Contains(out.String(), "tdk_secret") {
				t.Errorf("doctor printed the sync key:\n%s", &out)
			}
		})
	}
}

// A disposable machine is told about its secrets, not to log in or sync:
// either would make it a computer of its own, with a key that goes with it.
func TestDoctorInTheCloud(t *testing.T) {
	site := func(t *testing.T, key string) string {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+key {
				http.Error(w, "This server needs your sync key.", http.StatusUnauthorized)
				return
			}
			fmt.Fprintf(w, `{"name":"Ada","handle":"ada","time":%q}`, time.Now().Format(time.RFC3339Nano))
		}))
		t.Cleanup(ts.Close)
		return ts.URL
	}
	for _, c := range []struct {
		name          string
		flag          string // the variable that marks the machine as a cloud one
		server, key   bool   // whether each secret is set; the key is the right one unless stale
		stale         bool
		finding       string
		level         int
		detail, fix   string
		noLastSync    bool
		noLoginAdvice bool
	}{
		{name: "both secrets", flag: "CLAUDE_CODE_REMOTE", server: true, key: true, finding: "Cloud mode", level: levelOK, detail: "on, since CLAUDE_CODE_REMOTE is set", noLastSync: true},
		{name: "no key", flag: "CODESPACES", server: true, finding: "Cloud mode", level: levelNote, detail: "CODESPACES is set, but HELIOS_KEY is not", fix: "Add HELIOS_KEY as a secret"},
		{name: "no key, so no login", flag: "CODESPACES", server: true, finding: "Site", level: levelFix, detail: "no sync key", fix: "Add HELIOS_KEY", noLoginAdvice: true},
		{name: "no secrets", flag: "HELIOS_CLOUD", finding: "Cloud mode", level: levelNote, detail: "HELIOS_SERVER and HELIOS_KEY are not", fix: "Add HELIOS_SERVER and HELIOS_KEY"},
		{name: "a key the site forgot", flag: "CLAUDE_CODE_REMOTE", server: true, key: true, stale: true, finding: "Site", level: levelFix, detail: "does not know the sync key in HELIOS_KEY", fix: "Replace HELIOS_KEY", noLastSync: true},
		// The same on a machine that is kept, such as an SSH box set up by its environment.
		{name: "a stale key on an SSH box", server: true, key: true, stale: true, finding: "Site", level: levelFix, detail: "does not know the sync key in HELIOS_KEY", fix: "Replace HELIOS_KEY"},
		{name: "not a cloud machine", server: true, key: true, finding: "Last sync", level: levelNote, detail: "never", fix: "helios sync"},
	} {
		t.Run(c.name, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("HOME", root)
			t.Setenv("USERPROFILE", root)
			t.Setenv("XDG_CONFIG_HOME", root)
			t.Setenv("HELIOS_DATA_DIR", filepath.Join(root, "data"))
			t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "no-claude"))
			t.Setenv("CODEX_HOME", filepath.Join(root, "no-codex"))
			t.Setenv("PATH", "")
			for _, v := range []string{"HELIOS_CLOUD", "CLAUDE_CODE_REMOTE", "CODESPACES", "HELIOS_SERVER", "HELIOS_KEY"} {
				t.Setenv(v, "")
			}
			if c.flag != "" {
				t.Setenv(c.flag, "true")
			}
			if c.server {
				t.Setenv("HELIOS_SERVER", site(t, "tdk_secret"))
			}
			if c.key {
				t.Setenv("HELIOS_KEY", map[bool]string{false: "tdk_secret", true: "tdk_stale"}[c.stale])
			}
			findings := diagnose("", "", &http.Client{Timeout: 5 * time.Second}, "http://127.0.0.1:1")
			var got *finding
			for i := range findings {
				if findings[i].Name == c.finding {
					got = &findings[i]
				}
				if c.noLastSync && findings[i].Name == "Last sync" {
					t.Errorf("a cloud machine was told about its last sync: %+v", findings[i])
				}
				if c.noLoginAdvice && strings.Contains(findings[i].Fix, "helios login") {
					t.Errorf("a cloud machine was told to log in: %+v", findings[i])
				}
			}
			if got == nil || got.Level != c.level || !strings.Contains(got.Detail, c.detail) || !strings.Contains(got.Fix, c.fix) {
				t.Fatalf("got %+v, want %s at level %d with %q and fix %q in %+v", got, c.finding, c.level, c.detail, c.fix, findings)
			}
			if _, err := os.Stat(filepath.Join(root, "data", "account.key")); err == nil {
				t.Error("doctor made an account key")
			}
		})
	}
}

// A background command's error is kept until a later run of that same
// command succeeds: another command's success says nothing about it.
func TestKeepError(t *testing.T) {
	t.Setenv("HELIOS_DATA_DIR", t.TempDir())
	keepError("sync", errors.New("server said 500"))
	keepError("relay", nil)
	if e, ok := readLastError(); !ok || e.Command != "sync" || e.Message != "server said 500" {
		t.Fatalf("a relay that worked cleared the sync's error: kept %+v, %v", e, ok)
	}
	time.Sleep(10 * time.Millisecond)
	keepError("update", errors.New("download failed"))
	if e, _ := readLastError(); e.Command != "update" {
		t.Fatalf("the newest error is shown first, got %+v", e)
	}
	keepError("update", nil)
	if e, _ := readLastError(); e.Command != "sync" {
		t.Fatalf("after the update worked, the sync's error remains, got %+v", e)
	}
	keepError("sync", nil)
	if _, ok := readLastError(); ok {
		t.Error("a successful run left its error")
	}
}
