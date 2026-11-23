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
			s.whoami, s.name, s.level, s.detail = refuse(404, "Not found"), "Site", levelNote, "older than this teardrop"
		}),
		with(func(s *state) {
			s.whoami, s.name, s.level, s.detail, s.failsDoc = at(-9*time.Minute), "Clock", levelFix, "9 minutes behind", true
		}),
		with(func(s *state) { s.whoami, s.name, s.level, s.detail = at(40*time.Second), "Clock", levelOK, "matches" }),
		with(func(s *state) {
			s.hookExe, s.name, s.level, s.detail, s.failsDoc = "", "Claude Code hooks", levelFix, "not installed", true
		}),
		with(func(s *state) {
			s.hookExe, s.name, s.level, s.detail, s.failsDoc = "/gone/teardrop", "Claude Code hooks", levelFix, "/gone/teardrop, which is no longer there", true
		}),
		with(func(s *state) {
			s.queued, s.name, s.level, s.detail = 3, "Waiting", levelNote, "3 records not sent yet"
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
			t.Setenv("TEARDROP_DATA_DIR", data)
			t.Setenv("CLAUDE_CONFIG_DIR", claude)
			t.Setenv("CODEX_HOME", filepath.Join(root, "no-codex"))
			t.Setenv("TEARDROP_SERVER", "")
			t.Setenv("TEARDROP_KEY", "")
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
				exe = filepath.ToSlash(filepath.Join(root, "teardrop"))
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

// A background sync's error is kept until a later run succeeds.
func TestKeepError(t *testing.T) {
	t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
	keepError("relay", errors.New("server said 401"))
	if e, ok := readLastError(); !ok || e.Command != "relay" || e.Message != "server said 401" {
		t.Fatalf("kept %+v, %v", e, ok)
	}
	keepError("sync", nil)
	if _, ok := readLastError(); ok {
		t.Error("a successful run left the error")
	}
}
