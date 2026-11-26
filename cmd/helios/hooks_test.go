package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/helios/internal/sources"
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
	old := `"/opt/helios" hook claude-code`

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
	moved := `"C:/Users/kid/AppData/Local/Programs/helios/helios.exe" hook claude-code`
	if changed, _ := setHooks(settings, moved, true); !changed {
		t.Error("new path not applied")
	}
	n := 0
	for _, cmds := range commands(t, settings["hooks"]) {
		for _, c := range cmds {
			if strings.Contains(c, "/opt/helios") {
				t.Errorf("old hook left behind: %s", c)
			}
			if strings.Contains(c, "helios.exe") {
				n++
			}
		}
	}
	if n != len(hookEvents) {
		t.Errorf("%d helios hooks, want %d", n, len(hookEvents))
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
	got := string(renderAmpPlugin(`C:\Users\kid\AppData\Local\Programs\helios\helios.exe`))
	if !strings.Contains(got, `const helios = "C:\\Users\\kid\\AppData\\Local\\Programs\\helios\\helios.exe"`) || strings.Contains(got, "__HELIOS_PATH__") {
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

func TestCloudEnv(t *testing.T) {
	for _, k := range []string{"HELIOS_SERVER", "HELIOS_KEY", "HELIOS_CLOUD", "CLAUDE_CODE_REMOTE", "CODESPACES"} {
		t.Setenv(k, "")
	}
	if cloudEnv() {
		t.Error("an empty environment is not a cloud one")
	}
	t.Setenv("CLAUDE_CODE_REMOTE", "true")
	if cloudEnv() {
		t.Error("cloud without a site and key must stay local")
	}
	t.Setenv("HELIOS_SERVER", "https://x.example")
	t.Setenv("HELIOS_KEY", "td-abc")
	if !cloudEnv() {
		t.Error("remote Claude Code with a site and key should relay")
	}
}

func TestLastTurnUsage(t *testing.T) {
	log := `{"type":"user","timestamp":"2026-11-20T15:00:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"first"}}
{"type":"assistant","timestamp":"2026-11-20T15:00:05.000Z","requestId":"r1","message":{"id":"m1","content":"x","usage":{"input_tokens":100,"output_tokens":10}}}
{"type":"user","timestamp":"2026-11-20T15:05:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"second"}}
{"type":"assistant","timestamp":"2026-11-20T15:05:05.000Z","requestId":"r2","message":{"id":"m2","content":"y","usage":{"input_tokens":7,"output_tokens":3}}}
{"type":"assistant","timestamp":"2026-11-20T15:05:06.000Z","isSidechain":true,"requestId":"r3","message":{"id":"m3","content":"z","usage":{"input_tokens":9999,"output_tokens":999}}}
`
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, []byte(log), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, in, out, _, _ := lastTurnUsage(path); in != 7 || out != 3 {
		t.Errorf("last turn = %d/%d, want 7/3 (first turn and subagent left out)", in, out)
	}
	if at, _, _, _, _ := lastTurnUsage(path); !at.Equal(time.Date(2026, 11, 20, 15, 5, 0, 0, time.UTC)) {
		t.Errorf("last turn's prompt time = %v, want 15:05, which keys its usage record", at)
	}
	if _, in, out, _, _ := lastTurnUsage(path + ".missing"); in != 0 || out != 0 {
		t.Errorf("missing file = %d/%d, want 0/0", in, out)
	}
}

// A transcript that holds no prompt, such as one cut off by the tail read or
// a resumed session's first lines, has no last turn: the whole file is not one.
func TestLastTurnUsageNeedsAPrompt(t *testing.T) {
	answer := `{"type":"assistant","timestamp":"2026-11-20T15:00:05.000Z","requestId":"r%d","message":{"id":"m%d","content":"x","usage":{"input_tokens":100,"output_tokens":10}}}` + "\n"
	path := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(path, []byte(fmt.Sprintf(answer, 1, 1)), 0o600)
	if _, in, out, _, _ := lastTurnUsage(path); in != 0 || out != 0 {
		t.Errorf("no prompt = %d/%d, want 0/0", in, out)
	}
	// A file longer than the tail is read from its end, past the cut line.
	var b strings.Builder
	b.WriteString(`{"type":"user","timestamp":"2026-11-20T14:00:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"first"}}` + "\n")
	for i := 0; b.Len() < usageTail+1<<20; i++ {
		fmt.Fprintf(&b, answer, i, i)
	}
	b.WriteString(`{"type":"user","timestamp":"2026-11-20T16:00:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"last"}}` + "\n")
	b.WriteString(`{"type":"assistant","timestamp":"2026-11-20T16:00:05.000Z","requestId":"last","message":{"id":"last","content":"y","usage":{"input_tokens":7,"output_tokens":3}}}` + "\n")
	os.WriteFile(path, []byte(b.String()), 0o600)
	if _, in, out, _, _ := lastTurnUsage(path); in != 7 || out != 3 {
		t.Errorf("long file's last turn = %d/%d, want 7/3", in, out)
	}
}

// Naming claude on a machine with no Claude Code folder makes the default
// one, and never a second one beside a folder that is already there.
func TestMakeDefaultDir(t *testing.T) {
	root := t.TempDir()
	dot, xdg := filepath.Join(root, ".claude"), filepath.Join(root, ".config", "claude")
	locs := []location{{Tool: "Codex", Dir: filepath.Join(root, ".codex")}, {Tool: "Claude Code", Dir: dot}, {Tool: "Claude Code", Dir: xdg}}
	makeDefaultDir(locs, "Claude Code")
	if !exists(dot) || exists(xdg) || exists(filepath.Join(root, ".codex")) {
		t.Fatalf("made .claude %v, .config/claude %v", exists(dot), exists(xdg))
	}
	makeDefaultDir(locs, "Claude Code")
	if exists(xdg) {
		t.Error("with ~/.claude there, ~/.config/claude was made too")
	}
	os.Remove(dot)
	os.MkdirAll(xdg, 0o755)
	makeDefaultDir(locs, "Claude Code")
	if exists(dot) {
		t.Error("with ~/.config/claude there, ~/.claude was made too")
	}
}

// A site named by the environment alone, as on an SSH box, counts as set.
func TestSiteSet(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HELIOS_DATA_DIR", dir)
	t.Setenv("HELIOS_SERVER", "")
	t.Setenv("HELIOS_KEY", "")
	if siteSet() {
		t.Error("no site is set")
	}
	t.Setenv("HELIOS_SERVER", "https://x.example")
	if siteSet() {
		t.Error("a site without a key can't be sent to")
	}
	t.Setenv("HELIOS_KEY", "tdk_k")
	if !siteSet() {
		t.Error("HELIOS_SERVER and HELIOS_KEY name a site")
	}
	t.Setenv("HELIOS_SERVER", "")
	t.Setenv("HELIOS_KEY", "")
	os.WriteFile(filepath.Join(dir, "server"), []byte("https://x.example\n"), 0o600)
	if !siteSet() {
		t.Error("a remembered site is set")
	}
}

func TestSetupProject(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root, _ := filepath.EvalSymlinks(t.TempDir())
	if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	sub := filepath.Join(root, "pkg")
	os.MkdirAll(filepath.Join(root, ".claude"), 0o755)
	os.MkdirAll(sub, 0o755)
	path := filepath.Join(root, ".claude", "settings.json")
	theirs := `{"permissions":{"allow":["Bash(npm test)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}`
	os.WriteFile(path, []byte(theirs), 0o644)

	// From a folder inside the repository, it finds the repository's settings.
	if err := setupProject(sub, true, false); err != nil {
		t.Fatal(err)
	}
	settings, err := readSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	got := commands(t, settings["hooks"])
	if strings.Join(got["Stop"], ",") != "|say done,|"+projectHook || strings.Join(got["SessionStart"], ",") != "|"+projectStart ||
		strings.Join(got["UserPromptSubmit"], ",") != "|"+projectHook || !strings.Contains(string(settings["permissions"]), "npm test") {
		t.Fatalf("after setup: %v\n%s", got, settings["permissions"])
	}
	// The session's start installs helios only when it is missing, and
	// everything is skipped without a key.
	for _, c := range []string{projectHook, projectStart} {
		if !strings.HasPrefix(c, `[ -z "$HELIOS_KEY" ] || `) || !ourCommand(c, "claude-code") {
			t.Errorf("not a no-op without a key, or not known as helios's: %s", c)
		}
	}
	if !strings.Contains(projectStart, "command -v helios >/dev/null || curl -fsSL https://raw.githubusercontent.com/part-avocado/helios/main/install.sh | HELIOS_NO_SETUP=1 sh") {
		t.Errorf("session start does not install helios when missing: %s", projectStart)
	}
	if _, err := os.Stat(path + ".helios-backup"); err == nil {
		t.Error("a backup was left in the repository")
	}
	before, _ := os.ReadFile(path)
	if err := setupProject(root, true, false); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Error("rerunning changed the settings again")
	}
	// What removes the hooks of a config folder removes these too.
	if err := setupProject(root, true, true); err != nil {
		t.Fatal(err)
	}
	settings, _ = readSettings(path)
	var want map[string]json.RawMessage
	json.Unmarshal([]byte(theirs), &want)
	if !sameJSON(settings["hooks"], want["hooks"]) || !sameJSON(settings["permissions"], want["permissions"]) {
		t.Errorf("after removal: %s", settings["hooks"])
	}
	if err := setupProject(t.TempDir(), true, false); err == nil {
		t.Error("a folder outside any repository was set up")
	}
}

// With a key, the project's hooks run the helios on PATH with the
// payload; without one they run nothing and still succeed.
func TestProjectHooksRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs sh")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "ran")
	os.WriteFile(filepath.Join(dir, "helios"), []byte("#!/bin/sh\necho \"$* $(cat)\" >>\""+log+"\"\n"), 0o755)
	for _, c := range []string{projectHook, projectStart} {
		for _, key := range []string{"", "tdk_k"} {
			os.Remove(log)
			cmd := exec.Command("sh", "-c", c)
			cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin", "HOME=" + dir, "HELIOS_KEY=" + key}
			cmd.Stdin = strings.NewReader("payload")
			out, err := cmd.CombinedOutput()
			ran, _ := os.ReadFile(log)
			if want := map[bool]string{false: "", true: "hook claude-code -project payload\n"}[key != ""]; err != nil || len(out) != 0 || string(ran) != want {
				t.Errorf("key %q: %s\nerr %v, printed %q, ran %q", key, c, err, out, ran)
			}
		}
	}
}

// A repository's committed hook stands down where the person's own Claude
// Code settings already run helios's hook, and nowhere else.
func TestUserHooked(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	claude := filepath.Join(home, "custom-claude")
	t.Setenv("CLAUDE_CONFIG_DIR", claude)
	os.MkdirAll(claude, 0o755)
	path := filepath.Join(claude, "settings.json")
	if userHooked() {
		t.Error("no settings, yet the person's own hooks were found")
	}
	// A repository in the config folder's parent has its own hooks there: not the person's.
	settings := map[string]json.RawMessage{}
	if _, err := setProjectHooks(settings, true); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(settings)
	os.WriteFile(path, b, 0o644)
	if userHooked() {
		t.Error("a repository's own hooks were taken for the person's")
	}
	if _, err := setHooks(settings, `"/usr/local/bin/helios" `+hookArgs, true); err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(settings)
	os.WriteFile(path, b, 0o644)
	if !userHooked() {
		t.Error("the person's own hooks were not found")
	}
	os.WriteFile(path, []byte(`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}`), 0o644)
	if userHooked() {
		t.Error("someone else's hook was taken for helios's")
	}
}

// Two hooks reporting one event moments apart make one record; the same
// event later, or another event, is a new one.
func TestRepeatedHook(t *testing.T) {
	at := time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC)
	last := sources.JournalEvent{Time: at, Tool: "claude-code", Event: "Stop", Session: "s"}
	ev := last
	ev.Time = at.Add(20 * time.Millisecond)
	if !repeatedHook(last, true, ev) {
		t.Error("the same event 20 ms later was not a repeat")
	}
	if repeatedHook(last, false, ev) {
		t.Error("a repeat of nothing")
	}
	ev.Time = at.Add(sameHook)
	if repeatedHook(last, true, ev) {
		t.Error("the same event 2 s later was dropped")
	}
	ev.Time, ev.Event = at.Add(20*time.Millisecond), "UserPromptSubmit"
	if repeatedHook(last, true, ev) {
		t.Error("another event was dropped")
	}
}
