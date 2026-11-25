package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/textscore"
	"github.com/part-avocado/teardrop/internal/timeline"
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
		// Text Claude Code writes in the user's turn itself is the agent at work, not a prompt.
		{name: "Claude Code task notice", tool: "claude-code", payload: `{"session_id":"abc","cwd":"/w","hook_event_name":"UserPromptSubmit","prompt":"<task-notification>\n<task-id>b1</task-id><status>completed</status>\n</task-notification>"}`, kind: "prompt", session: "abc", cwd: "/w"},
		{name: "Claude Code teammate message", tool: "claude-code", payload: `{"session_id":"abc","cwd":"/w","hook_event_name":"UserPromptSubmit","prompt":"  <teammate-message from=\"lead\">run the tests</teammate-message>"}`, kind: "prompt", session: "abc", cwd: "/w"},
		{name: "a person quoting a tag", tool: "claude-code", payload: `{"session_id":"abc","cwd":"/w","hook_event_name":"UserPromptSubmit","prompt":"why does the <task-notification> tag show up in my log?"}`, kind: "prompt", session: "abc", cwd: "/w", human: true},
		{name: "Codex hook", tool: "codex", payload: `{"session_id":"019a","cwd":"/w","hook_event_name":"Stop"}`, kind: "turn_end", session: "019a", cwd: "/w"},
		{name: "Codex notify", tool: "codex", payload: `{"type":"agent-turn-complete","thread-id":"019a","turn-id":"1","cwd":"/w","input-messages":["hi"]}`, kind: "turn_end", session: "019a", cwd: "/w"},
		{name: "Copilot CLI names no session or event", tool: "copilot", event: "userPromptSubmitted", payload: `{"timestamp":1704614400000,"cwd":"/w","prompt":"fix the flaky test"}`, kind: "prompt", session: "cwd:/w", cwd: "/w", human: true},
		{name: "VS Code Copilot", tool: "copilot", payload: `{"sessionId":"s1","hookEventName":"Stop","cwd":"/w"}`, kind: "turn_end", session: "s1", cwd: "/w"},
		{name: "Cursor prompt", tool: "cursor", payload: `{"conversation_id":"c1","generation_id":"g1","hook_event_name":"beforeSubmitPrompt","workspace_roots":["/w"],"prompt":"refactor this"}`, kind: "prompt", session: "c1", cwd: "/w", human: true},
		{name: "Cursor edit", tool: "cursor", payload: `{"conversation_id":"c1","hook_event_name":"afterFileEdit","file_path":"/w/a.go","edits":[{"old_string":"a\nb","new_string":"a\nc\nd"}]}`, kind: "edit", session: "c1", added: 2, removed: 1},
		// What teardrop's OpenCode plugin sent from a real OpenCode 2.4.1 turn.
		{name: "OpenCode prompt", tool: "opencode", event: "prompt", payload: `{"session_id":"ses_df60","cwd":"/w","prompt":"add a login page with tests"}`, kind: "prompt", session: "ses_df60", cwd: "/w", human: true},
		{name: "OpenCode turn end", tool: "opencode", event: "turn_end", payload: `{"session_id":"ses_df60","cwd":"/w","prompt":""}`, kind: "turn_end", session: "ses_df60", cwd: "/w"},
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
	// A turn's end starts a sync, so its time reaches the site in time to be witnessed.
	if !turnEnds["opencode"]["turn_end"] {
		t.Error("an OpenCode turn end does not start a sync")
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
	// Removing from a Cursor with no hooks file leaves it without one.
	if _, changed, _ := setCursorHooks(nil, "", false); changed {
		t.Error("removing hooks from no file would write one")
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

func TestListCommits(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE=2026-11-20T10:00:00Z", "GIT_COMMITTER_DATE=2026-11-20T10:00:00Z")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q")
	git("config", "user.email", "kid@example.com")
	git("config", "user.name", "Kid")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\n"), 0o600)
	git("add", ".")
	git("commit", "-qm", "first")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\nTWO\n"), 0o600)
	git("commit", "-qam", "second")
	got := listCommits(dir, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	if len(got) != 2 || len(got[0].Sha) != 40 || !got[0].Time.Equal(time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("got %+v", got)
	}
	// Newest first: the second commit changed one line and dropped one; the first added three.
	if got[0].Added != 1 || got[0].Removed != 2 || got[1].Added != 3 || got[1].Removed != 0 {
		t.Errorf("line counts: %+v", got)
	}
}

// A repository without a remote is keyed by its folder, which no host can
// check, so its commits stay on the computer, even keyed as ~/app.
func TestQueueCommitsNeedsARemote(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
	dir := filepath.Join(home, "app")
	os.MkdirAll(dir, 0o700)
	git := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q")
	git("-c", "user.email=kid@example.com", "-c", "user.name=Kid", "commit", "-q", "--allow-empty", "-m", "first")
	raws := []sources.Raw{{Tool: "claude-code", ID: "s", Cwd: dir}}
	if n := queueCommits(raws, time.Now()); n != 0 {
		t.Fatalf("queued %d commits of a repository with no remote", n)
	}
	// A remote that is a folder on this computer has no host to check against either.
	git("remote", "add", "origin", filepath.Join(home, "repos", "app.git"))
	os.Remove(filepath.Join(dataDir(), "last-commits"))
	if n := queueCommits(raws, time.Now()); n != 0 {
		t.Fatalf("queued %d commits of a repository whose remote is a local folder", n)
	}
	git("remote", "set-url", "origin", "git@github.com:kid/app.git")
	os.Remove(filepath.Join(dataDir(), "last-commits"))
	if n := queueCommits(raws, time.Now()); n != 1 {
		t.Errorf("queued %d commits once it has a remote, want 1", n)
	}
	// A cloud thread has no sync: its turn's end sends the commits to the relay outbox, keyed by the repository.
	if n := queueRelayCommits(dir, "~/app", time.Now()); n != 0 {
		t.Errorf("relayed %d commits of a folder key", n)
	}
	if n := queueRelayCommits(dir, "github.com/kid/app", time.Now()); n != 1 {
		t.Fatalf("relayed %d commits, want 1", n)
	}
	b, _ := os.ReadFile(filepath.Join(dataDir(), relayOutbox))
	if !strings.Contains(string(b), `"event":"commit"`) || !strings.Contains(string(b), `"git":"github.com/kid/app"`) {
		t.Errorf("relay outbox: %s", b)
	}
}

func TestCalibrate(t *testing.T) {
	at := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	ev := func(min int, k timeline.Kind) timeline.Event {
		return timeline.Event{Time: at.Add(time.Duration(min) * time.Minute), Kind: k}
	}
	// A prompt, the agent's reply 3 minutes later, and the next prompt 17 minutes after that.
	sessions := []timeline.Session{{Tool: "claude-code", ID: "s", Events: []timeline.Event{ev(0, timeline.Human), ev(3, timeline.Agent), ev(20, timeline.Human)}}}
	var b strings.Builder
	calibrate(&b, sessions)
	out := b.String()
	// Under 5m/5m: 3m watching plus the last 5m before the prompt. Under 2m/5m: 3m plus 2m.
	rows := map[string]string{}
	for _, l := range strings.Split(out, "\n") {
		if f := strings.Fields(l); len(f) == 5 {
			rows[f[0]] = strings.Join(f[1:], " ")
		}
	}
	if rows["5m*"] != "8m 8m 8m 8m" || rows["2m"] != "5m 5m 5m 5m" {
		t.Errorf("grid:\n%s", out)
	}
	if !strings.Contains(out, "a prompt") || !strings.Contains(out, "100%") {
		t.Errorf("the 17-minute gap before the prompt should be over the 5m cap:\n%s", out)
	}
}

func TestSyncRecords(t *testing.T) {
	at := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	m := func(min float64) time.Time { return at.Add(time.Duration(min * float64(time.Minute))) }
	// A transcript of two turns: hooks saw the first (prompt and Stop), not the second.
	transcript := sources.Raw{Tool: "claude-code", ID: "s", Cwd: "/w", Events: []timeline.Event{
		{Time: m(0), Kind: timeline.Human},
		{Time: m(1), Kind: timeline.Agent, In: 100},
		{Time: m(2), Kind: timeline.Agent, Out: 50, Added: 3},
		{Time: m(10), Kind: timeline.Human},
		{Time: m(11), Kind: timeline.Agent},
	}, Scores: map[int]textscore.Score{3: {Judged: 7, Real: 6}}}
	journal := []sources.JournalEvent{
		{Time: m(0.1), Tool: "claude-code", Event: "UserPromptSubmit", Session: "s", Cwd: "/w", Human: true},
		{Time: m(2.02), Tool: "claude-code", Event: "Stop", Session: "s", Cwd: "/w"},
	}
	resolve := func(sources.Raw) (timeline.Project, string) {
		return timeline.Project{Key: "github.com/kid/site"}, "/w"
	}
	recs := syncRecords([]sources.Raw{transcript}, journal, resolve, at.Add(-time.Hour))
	var got []string
	for _, r := range recs {
		if r.Git != "github.com/kid/site" || r.Cwd != "" {
			t.Errorf("a record names its folder, or not its project: %+v", r)
		}
		got = append(got, fmt.Sprintf("%s@%v in%d out%d +%d judged%d", r.Event, r.Time.Sub(at), r.In, r.Out, r.Added, r.Judged))
	}
	want := []string{
		"UserPromptSubmit@6s in0 out0 +0 judged0", "Stop@2m1.2s in0 out0 +0 judged0", // the hooks' own, sent again
		"usage@0s in100 out50 +3 judged0",                                        // the first turn's tokens and lines, and nothing the hooks sent
		"prompt@10m0s in0 out0 +0 judged7", "turn_end@11m0s in0 out0 +0 judged0", // the turn no hook saw
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("records:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// A later sync sends only what is after its cutoff, but still finds the first turn's hooks.
	if later := syncRecords([]sources.Raw{transcript}, journal, resolve, m(5)); len(later) != 2 || later[0].Event != "prompt" {
		t.Errorf("after the cutoff: %+v", later)
	}
}
