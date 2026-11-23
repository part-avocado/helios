//go:build e2e

// The end-to-end test builds teardrop and drives it the way a person and
// Claude Code do, in a throwaway home folder, against a fake site:
//
//	go test -tags e2e -run E2E ./cmd/teardrop
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// A prompt whose words are all in the dictionary, so it is judged, and
// whose text must never be written down or sent.
const secretPrompt = "please refactor the parser module and explain every change carefully marmalade"

func TestE2E(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "bin", "teardrop")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	build := exec.Command("go", "build", "-o", exe, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	// The fake site keeps every request body, and is slow to answer
	// records, as a site far away is: a hook must not wait for it.
	var mu sync.Mutex
	var bodies [][]byte
	var records []map[string]any
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, b)
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer tdk_e2e" {
			http.Error(w, "bad key", http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/api/v1/events" {
			w.Write([]byte("{}"))
			return
		}
		time.Sleep(3 * time.Second)
		n := 0
		for _, line := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
			var rec map[string]any
			if json.Unmarshal(line, &rec) == nil {
				mu.Lock()
				records = append(records, rec)
				mu.Unlock()
				n++
			}
		}
		json.NewEncoder(w).Encode(map[string]int{"records": n})
	}))
	defer site.Close()

	home := filepath.Join(root, "home")
	claude := filepath.Join(home, ".claude")
	project := filepath.Join(root, "project")
	for _, d := range []string{claude, project} {
		os.MkdirAll(d, 0o700)
	}
	env := append(os.Environ(),
		"HOME="+home, "USERPROFILE="+home,
		"LOCALAPPDATA="+filepath.Join(home, "AppData", "Local"), "APPDATA="+filepath.Join(home, "AppData", "Roaming"),
		"XDG_CONFIG_HOME="+filepath.Join(home, ".config"),
		"TEARDROP_DATA_DIR="+filepath.Join(root, "data"),
		"CLAUDE_CONFIG_DIR="+claude, "CODEX_HOME="+filepath.Join(home, ".codex"),
		"TEARDROP_SERVER=", "TEARDROP_KEY=",
	)
	run := func(stdin string, args ...string) string {
		t.Helper()
		cmd := exec.Command(exe, args...)
		cmd.Env, cmd.Dir = env, project
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("teardrop %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}

	// setup installs the Claude Code hooks, pointing at this binary.
	run("", "setup", "-yes", "claude")
	settings, _ := os.ReadFile(filepath.Join(claude, "settings.json"))
	if !strings.Contains(string(settings), filepath.ToSlash(exe)+`\" hook claude-code`) {
		t.Fatalf("setup did not install a hook running %s:\n%s", exe, settings)
	}

	run("", "sync", "-server", site.URL, "-key", "tdk_e2e")

	// Claude Code runs the hook with its stdout read through a pipe. The
	// hook returns at once, and its background relay and sync reach the site.
	for _, ev := range []map[string]string{
		{"hook_event_name": "UserPromptSubmit", "prompt": secretPrompt},
		{"hook_event_name": "Stop"},
	} {
		ev["session_id"], ev["cwd"] = "e2e-session", project
		payload, _ := json.Marshal(ev)
		hook := exec.Command(exe, "hook", "claude-code")
		hook.Env, hook.Dir = env, project
		hook.Stdin = bytes.NewReader(payload)
		start := time.Now()
		if _, err := hook.Output(); err != nil {
			t.Fatalf("hook %s: %v", ev["hook_event_name"], err)
		}
		if took := time.Since(start); took > 2*time.Second {
			t.Errorf("hook %s took %s; it must not wait for the site", ev["hook_event_name"], took)
		}
	}
	prompted := func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, rec := range records {
			if rec["session"] == "e2e-session" && rec["human"] == true && rec["judged"] != nil {
				return true
			}
		}
		return false
	}
	for deadline := time.Now().Add(20 * time.Second); !prompted() && time.Now().Before(deadline); {
		time.Sleep(200 * time.Millisecond)
	}
	if !prompted() {
		t.Fatal("the site never received the prompt's record from the hook's background relay or sync")
	}

	// A person's own relay and sync finish without error.
	run("", "relay", "-verbose")
	if out := run("", "sync"); !strings.Contains(out, "Sent") {
		t.Errorf("sync printed %q", out)
	}

	run("", "setup", "-yes", "-remove-hooks", "claude")
	settings, _ = os.ReadFile(filepath.Join(claude, "settings.json"))
	if strings.Contains(string(settings), "hook claude-code") {
		t.Errorf("setup -remove-hooks left teardrop's hooks:\n%s", settings)
	}

	// Let background syncs finish writing before reading every file.
	time.Sleep(4 * time.Second)
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || path == exe {
			return nil
		}
		if b, _ := os.ReadFile(path); bytes.Contains(b, []byte("marmalade")) {
			t.Errorf("%s holds the prompt text", path)
		}
		return nil
	})
	mu.Lock()
	defer mu.Unlock()
	for _, b := range bodies {
		if bytes.Contains(b, []byte("marmalade")) {
			t.Errorf("a request to the site held the prompt text: %.200s", b)
		}
	}
}
