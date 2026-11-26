//go:build e2e

// The end-to-end test builds helios and drives it the way a person and
// Claude Code do, in a throwaway home folder, against a fake site:
//
//	go test -tags e2e -run E2E ./cmd/helios
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// A prompt whose words are all in the dictionary, so it is judged, and
// whose text must never be written down or sent.
const secretPrompt = "please refactor the parser module and explain every change carefully marmalade"

func TestE2E(t *testing.T) {
	// Resolved, as setup resolves the binary it installs: macOS's temp folder
	// is under a symlink, and Windows's has a short 8.3 name.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(root, "bin", "helios")
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
	var loginComputer string
	var paths []string
	allowed := false // set once the person types the code on the site
	var site *httptest.Server
	site = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, b)
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/login":
			var in struct{ Computer string }
			json.Unmarshal(b, &in)
			mu.Lock()
			loginComputer = in.Computer
			mu.Unlock()
			fmt.Fprintf(w, `{"code":"tdl_e2e","user_code":"BCDF-GHJK","url":%q,"expires_in":15,"interval":1}`, site.URL+"/connect")
			return
		case r.URL.Path == "/api/v1/login/tdl_e2e":
			mu.Lock()
			ok := allowed
			mu.Unlock()
			if ok {
				w.Write([]byte(`{"status":"done","key":"tdk_e2e","name":"Ada"}`))
			} else {
				w.Write([]byte(`{"status":"pending"}`))
			}
			return
		}
		// The site may refuse versions below its MIN_VERSION, so every call says which this is.
		if r.Header.Get("X-Helios-Version") == "" {
			t.Errorf("%s %s did not say helios's version", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer tdk_e2e" {
			http.Error(w, "bad key", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/v1/whoami" {
			fmt.Fprintf(w, `{"name":"Ada","handle":"ada","time":%q}`, time.Now().Format(time.RFC3339Nano))
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
				rec["sent as"] = r.Header.Get("X-Helios-Computer")
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
	// In the home folder, so its key must not name the folder.
	project := filepath.Join(home, "code", "project")
	for _, d := range []string{claude, project} {
		os.MkdirAll(d, 0o700)
	}
	env := append(os.Environ(),
		"HOME="+home, "USERPROFILE="+home,
		"LOCALAPPDATA="+filepath.Join(home, "AppData", "Local"), "APPDATA="+filepath.Join(home, "AppData", "Roaming"),
		"XDG_CONFIG_HOME="+filepath.Join(home, ".config"),
		"HELIOS_DATA_DIR="+filepath.Join(root, "data"),
		"CLAUDE_CONFIG_DIR="+claude, "CODEX_HOME="+filepath.Join(home, ".codex"),
		"HELIOS_SERVER=", "HELIOS_KEY=", "ZDOTDIR=",
	)
	run := func(stdin string, args ...string) string {
		t.Helper()
		cmd := exec.Command(exe, args...)
		cmd.Env, cmd.Dir = env, project
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("helios %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}

	// setup installs the Claude Code hooks, pointing at this binary.
	run("", "setup", "-yes", "claude")
	settings, _ := os.ReadFile(filepath.Join(claude, "settings.json"))
	if !strings.Contains(string(settings), filepath.ToSlash(exe)+`\" hook claude-code`) {
		t.Fatalf("setup did not install a hook running %s:\n%s", exe, settings)
	}

	// login prints a code; the person types it on the site and allows the
	// computer it names. helios then keeps the key and syncs, and never
	// shows the key.
	login := exec.Command(exe, "login", "-server", site.URL, "-no-open")
	login.Env, login.Dir = env, project
	pipe, _ := login.StdoutPipe()
	login.Stderr = login.Stdout
	if err := login.Start(); err != nil {
		t.Fatal(err)
	}
	var loginOut strings.Builder
	lines := bufio.NewScanner(pipe)
	for lines.Scan() {
		line := lines.Text()
		loginOut.WriteString(line + "\n")
		mu.Lock()
		if strings.TrimSpace(line) == "BCDF-GHJK" && strings.Contains(loginOut.String(), "("+loginComputer+")") {
			allowed = true
		}
		mu.Unlock()
	}
	if err := login.Wait(); err != nil {
		t.Fatalf("helios login: %v\n%s", err, loginOut.String())
	}
	if !allowed || !strings.HasPrefix(loginComputer, "td-") {
		t.Fatalf("login never showed the code with this computer's ID (%q):\n%s", loginComputer, loginOut.String())
	}
	if out := loginOut.String(); !strings.Contains(out, "Connected to Ada's account") || !strings.Contains(out, "Sent") || strings.Contains(out, "tdk_e2e") {
		t.Fatalf("helios login printed:\n%s", out)
	}
	// A login to another site that fails leaves this computer connected to
	// the site it was: its server and key stay.
	data := filepath.Join(root, "data")
	server, _ := os.ReadFile(filepath.Join(data, "server"))
	key, _ := os.ReadFile(filepath.Join(data, "key"))
	typo := exec.Command(exe, "login", "-server", "http://127.0.0.1:1", "-no-open")
	typo.Env, typo.Dir = env, project
	if out, err := typo.CombinedOutput(); err == nil || !strings.Contains(string(out), "could not reach") {
		t.Fatalf("a login to a site that isn't there: %v\n%s", err, out)
	}
	if after, _ := os.ReadFile(filepath.Join(data, "server")); string(after) != string(server) {
		t.Fatalf("a failed login changed the server from %q to %q", server, after)
	}
	if after, _ := os.ReadFile(filepath.Join(data, "key")); len(key) == 0 || string(after) != string(key) {
		t.Fatal("a failed login lost the sync key")
	}

	// Claude Code runs the hook with its stdout read through a pipe. The
	// hook returns at once, and its background relay and sync reach the
	// site, even when the hook's process group is killed after it returns.
	for _, ev := range []map[string]string{
		{"hook_event_name": "UserPromptSubmit", "prompt": secretPrompt},
		{"hook_event_name": "Stop"},
	} {
		ev["session_id"], ev["cwd"] = "e2e-session", project
		payload, _ := json.Marshal(ev)
		hook := exec.Command(exe, "hook", "claude-code")
		hook.Env, hook.Dir = env, project
		hook.Stdin = bytes.NewReader(payload)
		ownGroup(hook)
		start := time.Now()
		if _, err := hook.Output(); err != nil {
			t.Fatalf("hook %s: %v", ev["hook_event_name"], err)
		}
		killGroup(hook)
		if took := time.Since(start); took > 2*time.Second {
			t.Errorf("hook %s took %s; it must not wait for the site", ev["hook_event_name"], took)
		}
	}
	prompted := func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, rec := range records {
			if rec["session"] == "e2e-session" && rec["human"] == true && rec["judged"] != nil && rec["git"] == "~/code/project" {
				return true
			}
		}
		return false
	}
	for deadline := time.Now().Add(20 * time.Second); !prompted() && time.Now().Before(deadline); {
		time.Sleep(200 * time.Millisecond)
	}
	if !prompted() {
		t.Fatal("the site never received the prompt's record, keyed ~/code/project, from the hook's background relay or sync")
	}

	// A person's own relay and sync finish without error.
	run("", "relay", "-verbose")
	if out := run("", "sync"); !strings.Contains(out, "Sent") {
		t.Errorf("sync printed %q", out)
	}

	// doctor passes on this computer, and fails once the hooks are gone.
	doctor := func() (string, int) {
		cmd := exec.Command(exe, "doctor")
		// No PATH, so an Amp CLI on the machine running the test is not found.
		cmd.Env, cmd.Dir = append(env, "PATH="), project
		out, _ := cmd.CombinedOutput()
		return string(out), cmd.ProcessState.ExitCode()
	}
	if out, code := doctor(); code != 0 || !strings.Contains(out, "Claude Code hooks: installed") {
		t.Errorf("doctor exited %d after setup:\n%s", code, out)
	}

	run("", "setup", "-yes", "-remove-hooks", "claude")
	if out, code := doctor(); code != 1 || !strings.Contains(out, "Claude Code hooks: not installed") {
		t.Errorf("doctor exited %d after the hooks were removed:\n%s", code, out)
	}
	settings, _ = os.ReadFile(filepath.Join(claude, "settings.json"))
	if strings.Contains(string(settings), "hook claude-code") {
		t.Errorf("setup -remove-hooks left helios's hooks:\n%s", settings)
	}

	// In a cloud container, named so by its environment, the same hooks keep
	// no journal: each event goes straight to the site as the "cloud"
	// computer, and the reply's end sends the turn's tokens, read from the
	// transcript, as a usage record, since no sync will read it later.
	workspace, cloudData := filepath.Join(root, "workspace"), filepath.Join(root, "cloud-data")
	os.MkdirAll(workspace, 0o700)
	transcript := filepath.Join(root, "cloud-session.jsonl")
	os.WriteFile(transcript, []byte(`{"type":"user","timestamp":"2026-11-20T15:00:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"first"}}
{"type":"assistant","timestamp":"2026-11-20T15:00:05.000Z","requestId":"r1","message":{"id":"m1","content":"x","usage":{"input_tokens":7,"output_tokens":3}}}
`), 0o600)
	cloud := append(slices.Clone(env), "HELIOS_DATA_DIR="+cloudData, "HELIOS_SERVER="+site.URL, "HELIOS_KEY=tdk_e2e", "HELIOS_CLOUD=1")
	for _, ev := range []map[string]string{
		{"hook_event_name": "UserPromptSubmit", "prompt": secretPrompt},
		{"hook_event_name": "Stop"},
		// The turn stops again with no prompt typed between, as after a background task's notice.
		{"hook_event_name": "Stop"},
	} {
		ev["session_id"], ev["cwd"], ev["transcript_path"] = "cloud-session", workspace, transcript
		payload, _ := json.Marshal(ev)
		hook := exec.Command(exe, "hook", "claude-code")
		hook.Env, hook.Dir = cloud, workspace
		hook.Stdin = bytes.NewReader(payload)
		if out, err := hook.CombinedOutput(); err != nil || len(out) != 0 {
			t.Fatalf("cloud hook %s: %v, printed %q", ev["hook_event_name"], err, out)
		}
	}
	// In a clone, the repository's key names the project, and the folder's path stays on the machine.
	clone := filepath.Join(root, "clone")
	os.MkdirAll(clone, 0o700)
	for _, args := range [][]string{{"init", "-q"}, {"remote", "add", "origin", "https://github.com/ada/thing.git"}} {
		git := exec.Command("git", args...)
		git.Dir, git.Env = clone, env
		if out, err := git.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	{
		payload, _ := json.Marshal(map[string]string{"hook_event_name": "UserPromptSubmit", "prompt": "add a test", "session_id": "cloud-clone", "cwd": clone})
		hook := exec.Command(exe, "hook", "claude-code")
		hook.Env, hook.Dir = cloud, clone
		hook.Stdin = bytes.NewReader(payload)
		if out, err := hook.CombinedOutput(); err != nil || len(out) != 0 {
			t.Fatalf("cloud hook in a clone: %v, printed %q", err, out)
		}
	}
	flush := exec.Command(exe, "relay", "-verbose")
	flush.Env, flush.Dir = cloud, workspace
	if out, err := flush.CombinedOutput(); err != nil {
		t.Fatalf("relay in the cloud: %v\n%s", err, out)
	}
	mu.Lock()
	var cloudPrompt, cloudEnd map[string]any
	var cloudUsage []map[string]any
	cloned := false
	for _, rec := range records {
		if rec["session"] == "cloud-clone" {
			cloned = true
			if rec["git"] != "github.com/ada/thing" || rec["cwd"] != nil {
				t.Errorf("a cloud record from a clone: git %v, cwd %v; want the repository's key and no folder", rec["git"], rec["cwd"])
			}
		}
		if rec["session"] != "cloud-session" {
			continue
		}
		if rec["sent as"] != "cloud" || rec["cwd"] != workspace {
			t.Errorf("a cloud record was sent as %q from folder %v", rec["sent as"], rec["cwd"])
		}
		if rec["human"] == true {
			cloudPrompt = rec
		} else if rec["event"] == "Stop" {
			if rec["in"] != nil || rec["out"] != nil {
				t.Errorf("a cloud turn end carries tokens, which a second Stop would add again: %v", rec)
			}
			cloudEnd = rec
		} else if rec["event"] == "usage" {
			cloudUsage = append(cloudUsage, rec)
		}
	}
	mu.Unlock()
	if cloudPrompt == nil || cloudPrompt["in"] != nil || cloudPrompt["judged"] == nil {
		t.Errorf("the cloud prompt's record: %v; want one, scored, without the transcript's tokens", cloudPrompt)
	}
	if !cloned {
		t.Error("the cloud prompt from a clone was not sent")
	}
	if cloudEnd == nil {
		t.Error("the cloud turn's end was not sent")
	}
	// Each Stop sends the turn's usage keyed by the turn's prompt time, so the site replaces it and never adds it twice.
	// Background relays may send a record more than once, so only its key is checked, not how often it came.
	if len(cloudUsage) == 0 {
		t.Error("the cloud turn's usage was not sent")
	}
	for _, u := range cloudUsage {
		if u["t"] != "2026-11-20T15:00:00Z" || u["in"] != float64(7) || u["out"] != float64(3) || u["human"] != nil {
			t.Errorf("a cloud usage record: %v; want the turn's 7 tokens in and 3 out at its prompt's time", u)
		}
	}
	if journal, _ := filepath.Glob(filepath.Join(cloudData, "events-*.jsonl")); len(journal) != 0 {
		t.Errorf("a cloud hook kept a journal: %v", journal)
	}
	for _, f := range []string{"account.key", localOutbox} {
		if _, err := os.Stat(filepath.Join(cloudData, f)); err == nil {
			t.Errorf("a cloud hook made %s", f)
		}
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
	// Counting cloud threads is Amp's, so Claude Code's turn end asks for none.
	if slices.Contains(paths, "/api/v1/cloud") {
		t.Error("a Claude Code hook in the cloud counted cloud threads, which only Amp's does")
	}
	for _, b := range bodies {
		if bytes.Contains(b, []byte("marmalade")) {
			t.Errorf("a request to the site held the prompt text: %.200s", b)
		}
		homeJSON, _ := json.Marshal(home) // a Windows path, as JSON writes it
		if bytes.Contains(b, []byte(filepath.ToSlash(home))) || bytes.Contains(b, homeJSON[1:len(homeJSON)-1]) {
			t.Errorf("a request to the site held the home folder's path: %.300s", b)
		}
	}

	// uninstall takes out the hooks and the installer's PATH line, leaving
	// the rest of the profile byte for byte, then the data and the binary.
	run("", "setup", "-yes", "claude")
	// OpenCode's plugin runs this binary, and goes with the rest.
	openCode := filepath.Join(home, ".config", "opencode")
	os.MkdirAll(openCode, 0o700)
	run("", "setup", "-yes", "opencode")
	lit, _ := json.Marshal(exe)
	if plugin, _ := os.ReadFile(filepath.Join(openCode, "plugins", "helios.ts")); !bytes.Contains(plugin, []byte("const helios = "+string(lit))) {
		t.Errorf("setup opencode did not write a plugin running %s", exe)
	}
	// The PATH line install.sh added. On Windows it runs in Git Bash, which
	// writes .bashrc, and names the folder its own way, /c/Users/....
	rc, dir := ".zshrc", filepath.Dir(exe)
	if runtime.GOOS == "windows" {
		rc, dir = ".bashrc", "/"+strings.ToLower(dir[:1])+filepath.ToSlash(dir[2:])
	}
	mine := "alias g=git\n"
	os.WriteFile(filepath.Join(home, rc), []byte(mine+installerMark+`export PATH="`+dir+`:$PATH"`+"\n"), 0o644)
	out := run("", "uninstall", "-yes")
	if b, _ := os.ReadFile(filepath.Join(home, rc)); string(b) != mine {
		t.Errorf("uninstall left %s as %q", rc, b)
	}
	if settings, _ = os.ReadFile(filepath.Join(claude, "settings.json")); strings.Contains(string(settings), "hook claude-code") {
		t.Errorf("uninstall left helios's hooks:\n%s", settings)
	}
	if _, err := os.Stat(filepath.Join(openCode, "plugins", "helios.ts")); !os.IsNotExist(err) {
		t.Error("uninstall left the OpenCode plugin")
	}
	if _, err := os.Stat(filepath.Join(root, "data")); !os.IsNotExist(err) {
		t.Errorf("uninstall -yes kept the data folder:\n%s", out)
	}
	// Windows can't delete a running program, so there it says to.
	if _, err := os.Stat(exe); (err == nil) != (runtime.GOOS == "windows") {
		t.Errorf("after uninstall, the binary exists: %v\n%s", err == nil, out)
	}
}
