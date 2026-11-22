package main

import (
	"encoding/json"
	"flag"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

// commands lists each event's hook commands, in order.
func commands(t *testing.T, raw json.RawMessage) map[string][]string {
	var hooks map[string][]struct {
		Matcher string `json:"matcher"`
		Hooks   []struct {
			Command string `json:"command"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(raw, &hooks); err != nil {
		t.Fatal(err)
	}
	out := map[string][]string{}
	for ev, groups := range hooks {
		for _, g := range groups {
			for _, h := range g.Hooks {
				out[ev] = append(out[ev], g.Matcher+"|"+h.Command)
			}
		}
	}
	return out
}

func TestSetHooks(t *testing.T) {
	user := `{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}],"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"check.sh"}]}]}`
	settings := map[string]json.RawMessage{"theme": json.RawMessage(`"dark"`), "hooks": json.RawMessage(user)}
	old := `"/opt/teardrop" hook claude-code`

	if changed, err := setHooks(settings, old, true); err != nil || !changed {
		t.Fatalf("install: changed %v err %v", changed, err)
	}
	got := commands(t, settings["hooks"])
	if strings.Join(got["Stop"], ",") != "|say done,|"+old || strings.Join(got["PreToolUse"], ",") != "Bash|check.sh" ||
		len(got["UserPromptSubmit"]) != 1 || len(got["SessionStart"]) != 1 || len(got["SessionEnd"]) != 1 {
		t.Fatalf("after install: %v", got)
	}
	if changed, _ := setHooks(settings, old, true); changed {
		t.Error("rerunning setup changed the settings again")
	}

	// A moved binary replaces the old hooks instead of adding more.
	moved := `"C:/Users/kid/AppData/Local/Programs/teardrop/teardrop.exe" hook claude-code`
	if changed, _ := setHooks(settings, moved, true); !changed {
		t.Error("new path not applied")
	}
	n := 0
	for _, cmds := range commands(t, settings["hooks"]) {
		for _, c := range cmds {
			if strings.Contains(c, "/opt/teardrop") {
				t.Errorf("old hook left behind: %s", c)
			}
			if strings.Contains(c, "teardrop.exe") {
				n++
			}
		}
	}
	if n != len(hookEvents) {
		t.Errorf("%d teardrop hooks, want %d", n, len(hookEvents))
	}

	// Removing restores exactly the user's own hooks.
	if changed, _ := setHooks(settings, "", false); !changed || !sameJSON(settings["hooks"], json.RawMessage(user)) {
		t.Errorf("after removal: %s", settings["hooks"])
	}
	if string(settings["theme"]) != `"dark"` {
		t.Error("unrelated setting changed")
	}

	if _, err := setHooks(map[string]json.RawMessage{"hooks": json.RawMessage(`[1]`)}, old, true); err == nil {
		t.Error("an unrecognized hooks shape was overwritten instead of refused")
	}
}

func TestRenderAmpPlugin(t *testing.T) {
	got := string(renderAmpPlugin(`C:\Users\kid\AppData\Local\Programs\teardrop\teardrop.exe`))
	if !strings.Contains(got, `const teardrop = "C:\\Users\\kid\\AppData\\Local\\Programs\\teardrop\\teardrop.exe"`) || strings.Contains(got, "__TEARDROP_PATH__") {
		t.Errorf("path not filled in as a string literal:\n%s", got)
	}
	if !strings.HasPrefix(got, ampPluginMarker) {
		t.Error("rendered plugin lacks the marker that setup uses to recognize it")
	}
}

func TestParseSetupArgs(t *testing.T) {
	parse := func(args ...string) (map[string]bool, bool, string, error) {
		fs := flag.NewFlagSet("setup", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		yes := fs.Bool("yes", false, "")
		dir := fs.String("claude-dir", "", "")
		only, err := parseSetupArgs(fs, args)
		return only, *yes, *dir, err
	}
	// A flag after the tool name still counts, and a flag's value is not
	// mistaken for a tool.
	only, yes, dir, err := parse("amp", "-yes", "-claude-dir", "codex", "Claude")
	if err != nil || !yes || dir != "codex" || len(only) != 2 || !only["Amp"] || !only["Claude Code"] {
		t.Errorf("got tools %v, yes %v, dir %q, err %v", only, yes, dir, err)
	}
	if only, _, _, err := parse("-yes"); err != nil || len(only) != 0 {
		t.Errorf("no tool named should mean every tool, got %v, %v", only, err)
	}
	if _, _, _, err := parse("notepad"); err == nil {
		t.Error("an unknown tool was accepted instead of refused")
	}
}

func TestTurnLeftOpen(t *testing.T) {
	dir := t.TempDir()
	at := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	add := func(session, event string, minute int) {
		ev := sources.JournalEvent{Time: at.Add(time.Duration(minute) * time.Minute), Tool: "claude-code", Event: event, Session: session, Human: event == "UserPromptSubmit"}
		if err := sources.AppendJournal(dir, ev); err != nil {
			t.Fatal(err)
		}
	}
	if turnLeftOpen(dir, "claude-code", "interrupted", at) {
		t.Error("a session with no events was taken to have an open turn")
	}
	// Claude Code runs no hook when a reply is interrupted, so the prompt is
	// the last the journal holds of that turn.
	add("interrupted", "UserPromptSubmit", 0)
	add("finished", "UserPromptSubmit", 1)
	add("finished", "Stop", 2)
	later := at.Add(3 * time.Minute)
	if !turnLeftOpen(dir, "claude-code", "interrupted", later) {
		t.Error("a prompt with no Stop after it was not taken as an open turn")
	}
	if turnLeftOpen(dir, "claude-code", "finished", later) {
		t.Error("a turn that ended with Stop was taken as open")
	}
	if turnLeftOpen(dir, "amp", "interrupted", later) {
		t.Error("another tool's session of the same name was taken as this one")
	}
	if !turnEnds["claude-code"]["Stop"] || !turnEnds["amp"]["agent.end"] || turnEnds["claude-code"]["UserPromptSubmit"] {
		t.Errorf("turn ends: %v", turnEnds)
	}
}

func TestJournalKeepsAmpTokens(t *testing.T) {
	dir := t.TempDir()
	at := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	for _, ev := range []sources.JournalEvent{
		{Time: at, Tool: "amp", Event: "agent.start", Session: "T-1", Human: true, Judged: 6, Real: 6, Sim: 1},
		{Time: at.Add(2 * time.Minute), Tool: "amp", Event: "agent.end", Session: "T-1", In: 41000, Out: 900},
		{Time: at.Add(3 * time.Minute), Tool: "amp", Event: "agent.end", Session: "T-2", In: -5, Out: 7},
	} {
		if err := sources.AppendJournal(dir, ev); err != nil {
			t.Fatal(err)
		}
	}
	raws, _ := sources.ReadJournal(dir)
	if len(raws) != 2 || len(raws[0].Events) != 2 {
		t.Fatalf("read %d sessions: %+v", len(raws), raws)
	}
	if prompt, end := raws[0].Events[0], raws[0].Events[1]; prompt.In != 0 || end.In != 41000 || end.Out != 900 {
		t.Errorf("tokens of the turn: prompt %d in, end %d in and %d out; want 0, 41000 and 900", prompt.In, end.In, end.Out)
	}
	if end := raws[1].Events[0]; end.In != 0 || end.Out != 7 {
		t.Errorf("a count below zero was kept: %d in, %d out", end.In, end.Out)
	}
}
