package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Payloads shaped like the examples in each vendor's hook docs.
func TestHookRecord(t *testing.T) {
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name, tool, event, payload string
		kind, session, cwd         string
		human                      bool
		added, removed             int
		in                         int64
	}{
		{name: "Claude Code prompt", tool: "claude-code", payload: `{"session_id":"abc","cwd":"/w","hook_event_name":"UserPromptSubmit","prompt":"add a login page with tests"}`, kind: "prompt", session: "abc", cwd: "/w", human: true},
		{name: "Codex hook", tool: "codex", payload: `{"session_id":"019a","cwd":"/w","hook_event_name":"Stop"}`, kind: "turn_end", session: "019a", cwd: "/w"},
		{name: "Codex notify", tool: "codex", payload: `{"type":"agent-turn-complete","thread-id":"019a","turn-id":"1","cwd":"/w","input-messages":["hi"]}`, kind: "turn_end", session: "019a", cwd: "/w"},
		{name: "Copilot CLI names no session or event", tool: "copilot", event: "userPromptSubmitted", payload: `{"timestamp":1704614400000,"cwd":"/w","prompt":"fix the flaky test"}`, kind: "prompt", session: "cwd:/w", cwd: "/w", human: true},
		{name: "VS Code Copilot", tool: "copilot", payload: `{"sessionId":"s1","hookEventName":"Stop","cwd":"/w"}`, kind: "turn_end", session: "s1", cwd: "/w"},
		{name: "Cursor prompt", tool: "cursor", payload: `{"conversation_id":"c1","generation_id":"g1","hook_event_name":"beforeSubmitPrompt","workspace_roots":["/w"],"prompt":"refactor this"}`, kind: "prompt", session: "c1", cwd: "/w", human: true},
		{name: "Cursor edit", tool: "cursor", payload: `{"conversation_id":"c1","hook_event_name":"afterFileEdit","file_path":"/w/a.go","edits":[{"old_string":"a\nb","new_string":"a\nc\nd"}]}`, kind: "edit", session: "c1", added: 2, removed: 1},
		{name: "any other harness", tool: "my-agent", event: "turn_end", payload: `{"session_id":"x","tokens_in":900,"tokens_out":40}`, kind: "turn_end", session: "x", in: 900},
	} {
		var in hookInput
		if err := json.Unmarshal([]byte(c.payload), &in); err != nil {
			t.Fatal(err)
		}
		ev, kind, ok := hookRecord(c.tool, c.event, in, now)
		if !ok || kind != c.kind || ev.Session != c.session || ev.Cwd != c.cwd || ev.Human != c.human || ev.Added != c.added || ev.Removed != c.removed || ev.In != c.in || ev.Tool != c.tool {
			t.Errorf("%s: got %+v kind %q ok %v", c.name, ev, kind, ok)
		}
		if b, _ := json.Marshal(ev); strings.Contains(string(b), "login") || strings.Contains(string(b), "flaky") {
			t.Errorf("%s: prompt text kept: %s", c.name, b)
		}
	}
	// Another harness must name a kind of the contract; a built-in may use its own names.
	var in hookInput
	json.Unmarshal([]byte(`{"session_id":"x","hook_event_name":"Stop"}`), &in)
	if _, _, ok := hookRecord("my-agent", "", in, now); ok {
		t.Error("an unknown event of an unknown harness was recorded")
	}
	if h := harnessFor("cursor"); h.Reply["prompt"] != `{"continue":true}` || harnessFor("claude-code").Reply["prompt"] != "" {
		t.Error("Cursor needs its reply to beforeSubmitPrompt, and Claude Code must get none")
	}
}

func TestSetNotify(t *testing.T) {
	exe := "/opt/teardrop"
	plain := "model = \"gpt-5\"\n\n[profiles.fast]\nmodel = \"mini\"\n"
	got, note := setNotify(plain, exe, true)
	if note != "" || !strings.Contains(got, "model = \"gpt-5\"\n"+notifyMark+"\nnotify = [\"/opt/teardrop\", \"hook\", \"codex\", \"-notify\"]\n\n[profiles.fast]") {
		t.Errorf("notify not added above the first table:\n%s", got)
	}
	if again, _ := setNotify(got, exe, true); again != got {
		t.Errorf("rerunning setup changed config.toml again:\n%s", again)
	}
	if back, _ := setNotify(got, exe, false); back != plain {
		t.Errorf("removal left:\n%q", back)
	}
	theirs := "notify = [\"say\", \"done\"]\n"
	if got, note := setNotify(theirs, exe, true); got != theirs || note == "" {
		t.Error("a person's own notify was replaced")
	}
	if got, _ := setNotify("", exe, true); !strings.HasPrefix(got, notifyMark) {
		t.Errorf("empty config: %q", got)
	}
}

func TestSetCursorHooks(t *testing.T) {
	theirs := `{"version":1,"hooks":{"stop":[{"command":"say done"}],"beforeShellExecution":[{"command":"./guard.sh"}]}}`
	cmd := `"/opt/teardrop" hook cursor`
	next, changed, err := setCursorHooks([]byte(theirs), cmd, true)
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	var doc struct {
		Hooks map[string][]struct{ Command string } `json:"hooks"`
	}
	json.Unmarshal(next, &doc)
	if len(doc.Hooks["stop"]) != 2 || doc.Hooks["stop"][0].Command != "say done" || len(doc.Hooks["beforeSubmitPrompt"]) != 1 || len(doc.Hooks["beforeShellExecution"]) != 1 {
		t.Errorf("after install: %s", next)
	}
	if _, changed, _ := setCursorHooks(next, cmd, true); changed {
		t.Error("rerunning setup changed hooks.json again")
	}
	back, _, _ := setCursorHooks(next, "", false)
	if !sameJSON(back, []byte(theirs)) {
		t.Errorf("after removal: %s", back)
	}
	if _, _, err := setCursorHooks([]byte(`[1]`), cmd, true); err == nil {
		t.Error("an unrecognized file was overwritten")
	}
}

func TestLocalRecordsQueue(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEARDROP_DATA_DIR", dir)
	var in hookInput
	json.Unmarshal([]byte(`{"session_id":"s","hook_event_name":"UserPromptSubmit","prompt":"hello there friend"}`), &in)
	ev, _, _ := hookRecord("claude-code", "", in, time.Now())
	if err := queueRelay(localOutbox, ev); err != nil || !hasFile(localOutbox) || hasFile(relayOutbox) {
		t.Fatalf("local record not queued apart from cloud events: %v", err)
	}
	var sent int
	sendOutbox(dir, localOutbox, func(b []byte) (int, error) { sent += strings.Count(string(b), "\n"); return 200, nil })
	if sent != 1 || hasFile(localOutbox) {
		t.Errorf("sent %d, outbox left %v", sent, hasFile(localOutbox))
	}
}
