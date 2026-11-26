package sources

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/timeline"
)

func kinds(ev []timeline.Event) string {
	var s strings.Builder
	for _, e := range ev {
		if e.Kind == timeline.Human {
			s.WriteByte('H')
		} else {
			s.WriteByte('A')
		}
	}
	return s.String()
}

func TestParseClaude(t *testing.T) {
	log := `{"type":"summary","summary":"x"}
{"type":"user","timestamp":"2026-11-20T15:00:00.000Z","cwd":"/src/app","sessionId":"s1","message":{"role":"user","content":"fix the bug"}}
{"type":"assistant","timestamp":"2026-11-20T15:00:05.000Z","message":{"role":"assistant","content":[{"type":"tool_use"}]}}
{"type":"user","timestamp":"2026-11-20T15:00:06.000Z","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}
{"type":"user","timestamp":"2026-11-20T15:00:07.000Z","isMeta":true,"message":{"role":"user","content":"<command-name>"}}
{"type":"user","timestamp":"2026-11-20T15:00:08.000Z","isSidechain":true,"message":{"role":"user","content":"subagent task"}}
not json
{"type":"user","timestamp":"2026-11-20T15:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}
{"type":"user","timestamp":"2026-11-20T15:02:00.000Z","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}}
{"type":"user","timestamp":"2026-11-20T15:03:00.000Z","message":{"role":"user","content":"<task-notification>build done</task-notification>"}}
{"type":"user","timestamp":"2026-11-20T15:04:00.000Z","origin":{"kind":"task-notification"},"message":{"role":"user","content":"looks typed but is not"}}
{"type":"user","timestamp":"2026-11-20T15:05:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"now add tests"}}
`
	r, err := ClaudeParser()(strings.NewReader(log), "file")
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != "s1" || r.Cwd != "/src/app" || kinds(r.Events) != "HAAAHAAAH" {
		t.Errorf("got id %q cwd %q kinds %s, want s1 /src/app HAAAHAAAH", r.ID, r.Cwd, kinds(r.Events))
	}
}

func TestClaudeSubagentIgnored(t *testing.T) {
	log := `{"type":"assistant","timestamp":"2026-11-20T15:00:05.000Z","isSidechain":true,"requestId":"s1","message":{"id":"m1","content":"x","usage":{"input_tokens":500,"output_tokens":50}}}
{"type":"assistant","timestamp":"2026-11-20T15:09:05.000Z","requestId":"r1","message":{"id":"m2","content":"y","usage":{"input_tokens":5,"output_tokens":3}}}
`
	r, _ := ClaudeParser()(strings.NewReader(log), "f")
	if in, out := sum(r); in != 5 || out != 3 || len(r.Events) != 1 {
		t.Errorf("subagent counted: tokens %d/%d, %d events; want 5/3, 1", in, out, len(r.Events))
	}
}

func TestParseCodex(t *testing.T) {
	log := `{"timestamp":"2026-11-20T15:00:00.000Z","type":"session_meta","payload":{"id":"c1","cwd":"/src/app","source":"cli","git":{"repository_url":"git@github.com:o/app.git"}}}
{"timestamp":"2026-11-20T15:00:01.000Z","type":"turn_context","payload":{"cwd":"/src/app/sub","model":"gpt"}}
{"timestamp":"2026-11-20T15:00:01.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[]}}
{"timestamp":"2026-11-20T15:00:01.200Z","type":"event_msg","payload":{"type":"user_message","message":"hi"}}
{"timestamp":"2026-11-20T15:00:09.000Z","type":"event_msg","payload":{"type":"agent_message","message":"done"}}
{"timestamp":"2026-11-20T15:00:10.000Z","type":"session_meta","payload":{"id":"parent","cwd":"/elsewhere"}}
`
	r, err := ParseCodex(strings.NewReader(log), "file")
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != "c1" || r.Cwd != "/src/app/sub" || r.GitURL != "git@github.com:o/app.git" || kinds(r.Events) != "AAHA" {
		t.Errorf("got id %q cwd %q git %q kinds %s", r.ID, r.Cwd, r.GitURL, kinds(r.Events))
	}

	sub := `{"timestamp":"2026-11-20T15:00:00.000Z","type":"session_meta","payload":{"id":"c2","cwd":"/src","source":{"subagent":"review"}}}
{"timestamp":"2026-11-20T15:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"from parent agent"}}
`
	r, _ = ParseCodex(strings.NewReader(sub), "file")
	if kinds(r.Events) != "A" {
		t.Errorf("subagent kinds = %s, want A", kinds(r.Events))
	}

	// Paginated rollouts (Codex 0.147+) drop user_message; the prompt is an item_completed UserMessage.
	paged := `{"timestamp":"2026-11-20T15:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"c3","cwd":"/src","source":"vscode","thread_source":"user","history_mode":"paginated"}}
{"timestamp":"2026-11-20T15:00:01.000Z","ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>"}]}}
{"timestamp":"2026-11-20T15:00:01.500Z","ordinal":2,"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage"}}}
{"timestamp":"2026-11-20T15:00:03.000Z","ordinal":3,"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage"}}}
`
	r, _ = ParseCodex(strings.NewReader(paged), "file")
	if kinds(r.Events) != "AHA" {
		t.Errorf("paginated kinds = %s, want AHA", kinds(r.Events))
	}
	review := strings.Replace(paged, `"thread_source":"user"`, `"thread_source":"guardian_review"`, 1)
	r, _ = ParseCodex(strings.NewReader(review), "file")
	if kinds(r.Events) != "AAA" {
		t.Errorf("reviewer kinds = %s, want AAA", kinds(r.Events))
	}
}

func sum(r Raw) (in, out int64) {
	for _, e := range r.Events {
		in, out = in+e.In, out+e.Out
	}
	return
}

func TestTokens(t *testing.T) {
	// One response written as two records repeats its usage; a resumed session
	// in another file copies it again. Each response counts once.
	resp := `{"type":"assistant","timestamp":"2026-11-20T15:00:05.000Z","requestId":"r1","message":{"id":"m1","content":"x","usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":7}}}
{"type":"assistant","timestamp":"2026-11-20T15:00:06.000Z","requestId":"r1","message":{"id":"m1","content":"y","usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":7}}}
`
	parse := ClaudeParser()
	r, _ := parse(strings.NewReader(resp+`{"type":"assistant","timestamp":"2026-11-20T15:01:00.000Z","requestId":"r2","message":{"id":"m2","content":"z","usage":{"input_tokens":5,"output_tokens":3}}}`), "a")
	if in, out := sum(r); in != 1115 || out != 10 {
		t.Errorf("claude tokens = %d/%d, want 1115/10", in, out)
	}
	r, _ = parse(strings.NewReader(resp), "resumed")
	if in, out := sum(r); in != 0 || out != 0 || len(r.Events) != 2 {
		t.Errorf("copied response counted again: %d/%d", in, out)
	}

	// Codex token_count carries running totals and is sometimes repeated.
	codex := `{"timestamp":"2026-11-20T15:00:00.000Z","type":"session_meta","payload":{"id":"c1","cwd":"/src","source":"cli"}}
{"timestamp":"2026-11-20T15:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":null}}
{"timestamp":"2026-11-20T15:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50}}}}
{"timestamp":"2026-11-20T15:00:02.100Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50}}}}
{"timestamp":"2026-11-20T15:00:09.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2500,"cached_input_tokens":1900,"output_tokens":90}}}}
`
	r, _ = ParseCodex(strings.NewReader(codex), "c")
	if in, out := sum(r); in != 2500 || out != 90 {
		t.Errorf("codex tokens = %d/%d, want 2500/90", in, out)
	}
}

func TestPromptText(t *testing.T) {
	// Prompt text reaches the text score; odd field shapes don't drop the record.
	log := `{"type":"user","timestamp":"2026-11-20T15:00:00.000Z","origin":"weird","message":{"content":"fsdhfhfd fafkigsfak"}}
{"type":"user","timestamp":"2026-11-20T15:00:01.000Z","message":{"content":[{"type":"text","text":"move it more leftwards"},{"type":"tool_result"}]}}
`
	r, _ := ClaudeParser()(strings.NewReader(log), "f")
	if len(r.Events) != 2 || r.Scores[1].Judged != 4 || r.Scores[1].Real != 4 {
		t.Errorf("claude scores = %+v (events %d)", r.Scores, len(r.Events))
	}
	codex := `{"timestamp":"2026-11-20T15:00:00.000Z","type":"session_meta","payload":{"id":"c","cwd":"/src","source":"cli"}}
{"timestamp":"2026-11-20T15:00:01.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"qwzrt fkjx please"}]}}}
`
	r, _ = ParseCodex(strings.NewReader(codex), "c")
	if s := r.Scores[0]; s.Judged != 3 || s.Real != 1 {
		t.Errorf("codex score = %+v", s)
	}
}

func TestJournal(t *testing.T) {
	dir := t.TempDir()
	at := func(s string) time.Time { tt, _ := time.Parse(time.RFC3339, s); return tt }
	for _, ev := range []JournalEvent{
		{Time: at("2026-10-31T23:50:00Z"), Tool: "claude-code", Event: "SessionStart", Session: "a", Cwd: "/src/game"},
		{Time: at("2026-10-31T23:55:00Z"), Tool: "claude-code", Event: "UserPromptSubmit", Human: true, Session: "a", Judged: 6, Real: 5, Sim: 0xabc, Low: true},
		{Time: at("2026-11-01T00:02:00Z"), Tool: "claude-code", Event: "Stop", Session: "a", In: 900, Out: 40, Added: 12, Removed: -3}, // next month's file
		{Time: at("2026-11-01T00:03:00Z"), Tool: "amp", Event: "message", Human: true, Session: "a"},
	} {
		if err := AppendJournal(dir, ev); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(dir, "events-2026-11.jsonl"), append(mustRead(t, filepath.Join(dir, "events-2026-11.jsonl")), `{"t":"2026-11-01T00:04`...), 0o600)

	raws, warnings := ReadJournal(dir)
	if len(warnings) != 0 || len(raws) != 2 {
		t.Fatalf("got %d sessions, warnings %v", len(raws), warnings)
	}
	r := raws[0]
	if r.Tool != "claude-code" || r.Cwd != "/src/game" || kinds(r.Events) != "AHA" || r.Scores[1].Judged != 6 || r.Scores[1].Real != 5 || r.Scores[1].Sim != 0xabc || !r.Scores[1].Low {
		t.Errorf("claude session: %+v", r)
	}
	// What a harness reported of the turn stays with the event that ends it.
	if end := r.Events[2]; end.In != 900 || end.Out != 40 || end.Added != 12 || end.Removed != 0 {
		t.Errorf("turn end: %+v, want 900 in, 40 out, 12 added, and a count below zero dropped", end)
	}
	if raws[1].Tool != "amp" || kinds(raws[1].Events) != "H" {
		t.Errorf("same session ID from another tool must stay separate: %+v", raws[1])
	}
	if raws, _ := ReadJournal(filepath.Join(dir, "missing")); len(raws) != 0 {
		t.Error("missing dir should yield nothing")
	}
}

func mustRead(t *testing.T, p string) []byte {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestEdits(t *testing.T) {
	// A Write, then an Edit that changes one of three lines; the second file
	// is a fork that copies the Edit, which must count once.
	claude := `{"type":"assistant","timestamp":"2026-11-20T15:00:00Z","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"a.go","content":"package a\n\nfunc Hello() string {\n\treturn \"hi\"\n}\n"}}]}}
{"type":"assistant","timestamp":"2026-11-20T15:01:00Z","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"a.go","old_string":"func Hello() string {\n\treturn \"hi\"\n}","new_string":"func Hello() string {\n\treturn \"hello there\"\n}"}},{"type":"tool_use","id":"t3","name":"Read","input":{"file_path":"a.go"}}]}}
`
	parse := ClaudeParser()
	r, _ := parse(strings.NewReader(claude), "s")
	fork, _ := parse(strings.NewReader(claude[strings.Index(claude, "\n")+1:]), "fork")
	got := [][3]int{}
	for _, raw := range []Raw{r, fork} {
		for _, e := range raw.Events {
			got = append(got, [3]int{e.Added, e.Removed, len(raw.Edits)})
		}
	}
	// Write adds 4 non-blank lines; Edit swaps 1. "}" is too short to hash.
	if want := [][3]int{{4, 0, 2}, {1, 1, 2}, {0, 0, 0}}; !slices.Equal(got, want) {
		t.Errorf("claude edits = %v, want %v", got, want)
	}
	if h := r.Edits[0].Hashes; len(h) != 3 {
		t.Errorf("Write hashed %d lines, want 3 (all but \"}\")", len(h))
	}

	codex := `{"timestamp":"2026-11-20T15:00:00Z","type":"session_meta","payload":{"id":"c","cwd":"/src","source":"cli"}}
{"timestamp":"2026-11-20T15:00:01Z","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"apply_patch\",\"*** Begin Patch\\n*** Update File: a.go\\n@@\\n-\\treturn \\\"hi\\\"\\n+\\treturn \\\"hello\\\"\\n+\\t// greeting done\\n*** End Patch\"]}"}}
{"timestamp":"2026-11-20T15:00:02Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c2","input":"*** Begin Patch\n*** Add File: b.go\n+package b\n+\n*** End Patch"}}
{"timestamp":"2026-11-20T15:00:03Z","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c3","arguments":"{\"command\":[\"ls\",\"-la\"]}"}}
`
	c, _ := ParseCodex(strings.NewReader(codex), "c")
	var lines [][2]int
	for _, e := range c.Events {
		lines = append(lines, [2]int{e.Added, e.Removed})
	}
	if want := [][2]int{{2, 1}, {1, 0}, {0, 0}}; !slices.Equal(lines, want) {
		t.Errorf("codex edits = %v, want %v", lines, want)
	}
}

// Walk with a since time leaves out logs that were last written before it.
func TestWalkSince(t *testing.T) {
	dir := t.TempDir()
	line := `{"type":"user","timestamp":"2026-11-20T15:00:00.000Z","message":{"content":"fix the bug"}}` + "\n"
	for _, name := range []string{"old.jsonl", "new.jsonl"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(line), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	os.Chtimes(filepath.Join(dir, "old.jsonl"), now.Add(-10*24*time.Hour), now.Add(-10*24*time.Hour))

	if all, _ := Walk(dir, ClaudeParser(), time.Time{}); len(all) != 2 {
		t.Errorf("without a since time: %d logs, want 2", len(all))
	}
	recent, _ := Walk(dir, ClaudeParser(), now.Add(-2*24*time.Hour))
	if len(recent) != 1 || recent[0].ID != "new" {
		t.Errorf("since 2 days ago: %+v, want only new.jsonl", recent)
	}
}
