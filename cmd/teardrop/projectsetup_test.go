package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Antigravity runs PreInvocation before every model call. Only the first of
// an execution follows a person's prompt; the rest are the agent at work.
func TestAntigravityLaterInvocationsAreNotPrompts(t *testing.T) {
	var in hookInput
	json.Unmarshal([]byte(`{"conversationId":"c","workspacePaths":["/w"],"lastUserInput":"add a login page","invocationNum":3}`), &in)
	if _, _, ok := hookRecord("antigravity", "PreInvocation", in, time.Now()); ok {
		t.Error("a later model call was recorded as a prompt")
	}
}

func TestSetAntigravityHooks(t *testing.T) {
	theirs := `{"lint":{"enabled":true,"PreToolUse":[{"matcher":"run_command","hooks":[{"command":"./check.sh"}]}]}}`
	group := antigravityHookGroup(`"/bin/teardrop" hook antigravity`)
	next, changed, err := setAntigravityHooks([]byte(theirs), group)
	if err != nil || !changed {
		t.Fatalf("install: changed %v, %v", changed, err)
	}
	var doc map[string]map[string]json.RawMessage
	if err := json.Unmarshal(next, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["lint"] == nil {
		t.Error("their group was dropped")
	}
	for _, ev := range antigravityEvents {
		var hs []map[string]any
		json.Unmarshal(doc["teardrop"][ev], &hs)
		if c, _ := hs[0]["command"].(string); len(hs) != 1 || c != `"/bin/teardrop" hook antigravity -event `+ev {
			t.Errorf("%s runs %q", ev, c)
		}
	}
	if again, changed, _ := setAntigravityHooks(next, group); changed || string(again) != string(next) {
		t.Error("installing twice changed the file")
	}
	gone, changed, err := setAntigravityHooks(next, nil)
	if err != nil || !changed || strings.Contains(string(gone), "teardrop") || !strings.Contains(string(gone), "lint") {
		t.Errorf("remove: changed %v, %v: %s", changed, err, gone)
	}
	if _, _, err := setAntigravityHooks([]byte(`[1]`), group); err == nil {
		t.Error("a file of another shape was taken")
	}
}

// setup -project writes Codex's, Antigravity's, and OpenCode's repository
// hooks, keeping what the repository has, and takes them out again.
func TestToolProjectSetup(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("needs git")
	}
	repo := t.TempDir()
	if out, err := exec.Command("git", "-C", repo, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	os.MkdirAll(filepath.Join(repo, ".codex"), 0o755)
	os.WriteFile(filepath.Join(repo, ".codex", "hooks.json"), []byte(`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"make lint"}]}]}}`), 0o644)
	read := func(rel string) string {
		b, _ := os.ReadFile(filepath.Join(repo, filepath.FromSlash(rel)))
		return string(b)
	}
	quiet(t, func() {
		for _, tool := range []string{"Codex", "Antigravity", "OpenCode"} {
			if err := setupToolProject(repo, tool, true, false); err != nil {
				t.Fatalf("%s: %v", tool, err)
			}
		}
	})
	codex := read(".codex/hooks.json")
	if !strings.Contains(codex, "make lint") || !strings.Contains(codex, `teardrop hook codex -project`) || !strings.Contains(codex, "install.sh") {
		t.Errorf(".codex/hooks.json: %s", codex)
	}
	agy := read(".agents/hooks.json")
	if !strings.Contains(agy, `teardrop hook antigravity -project -event PreInvocation`) || !strings.Contains(agy, `echo '{}'`) {
		t.Errorf(".agents/hooks.json: %s", agy)
	}
	plugin := read(".opencode/plugins/teardrop-project.ts")
	if !strings.Contains(plugin, `const teardrop = "sh"`) || !strings.Contains(plugin, `exec teardrop \"$@\" -project`) || strings.Contains(plugin, "__TEARDROP") {
		t.Errorf("OpenCode plugin: %s", plugin)
	}

	quiet(t, func() {
		for _, tool := range []string{"Codex", "Antigravity", "OpenCode"} {
			if err := setupToolProject(repo, tool, true, true); err != nil {
				t.Fatalf("remove %s: %v", tool, err)
			}
		}
	})
	if c := read(".codex/hooks.json"); strings.Contains(c, "teardrop") || !strings.Contains(c, "make lint") {
		t.Errorf("after remove, .codex/hooks.json: %s", c)
	}
	if strings.Contains(read(".agents/hooks.json"), "teardrop") || read(".opencode/plugins/teardrop-project.ts") != "" {
		t.Error("remove left teardrop's hooks behind")
	}
}

// A repository's Antigravity hook answers {} even where teardrop doesn't run,
// and records nothing where TEARDROP_KEY is not set.
func TestAntigravityProjectHookAnswers(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("needs sh")
	}
	cmd := exec.Command(sh, "-c", projectCommand("antigravity", "Stop", false))
	cmd.Env = append(os.Environ(), "TEARDROP_KEY=")
	out, err := cmd.Output()
	if err != nil || string(out) != "{}\n" {
		t.Errorf("printed %q, %v", out, err)
	}
}

// Off a cloud machine, a repository hook of a tool other than Claude Code
// stands down: that tool's own hooks record the session there.
func TestProjectHookStandsDownOffCloud(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEARDROP_DATA_DIR", dir)
	t.Setenv("TEARDROP_SERVER", "")
	t.Setenv("TEARDROP_KEY", "")
	t.Setenv("TEARDROP_CLOUD", "")
	t.Setenv("CLAUDE_CODE_REMOTE", "")
	t.Setenv("CODESPACES", "")
	stdin := os.Stdin
	r, w, _ := os.Pipe()
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = stdin })
	w.WriteString(`{"session_id":"s","cwd":"/w","hook_event_name":"UserPromptSubmit","prompt":"add a login page"}`)
	w.Close()
	quiet(t, func() { runHook([]string{"codex", projectFlag}) })
	if entries, _ := os.ReadDir(dir); len(entries) > 0 {
		t.Error("a repository's Codex hook recorded on a computer that isn't a cloud machine")
	}
}

// quiet runs f with its output thrown away.
func quiet(t *testing.T, f func()) {
	t.Helper()
	stdout := os.Stdout
	null, _ := os.Open(os.DevNull)
	os.Stdout = null
	defer func() { os.Stdout = stdout; null.Close() }()
	f()
}
