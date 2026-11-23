package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The harness contract, version 1. A harness reports an event by running
//
//	teardrop hook <tool> [-event <kind>]
//
// with JSON on stdin: session_id, cwd, the event (hook_event_name, or the
// -event flag), and optionally prompt, time, tokens_in, tokens_out,
// lines_added, and lines_removed. The kinds are prompt, turn_end,
// session_start, session_end, and edit. Any tool name that matches toolName
// is accepted. teardrop exits 0, prints only the reply its adapter declares,
// and keeps no prompt text. The harnesses below are built in: each maps its
// own event names and payload onto the contract.

// toolName is what a harness may call itself.
var toolName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// kinds are the contract's events.
var hookKinds = map[string]bool{"prompt": true, "turn_end": true, "session_start": true, "session_end": true, "edit": true}

// harness is one AI coding tool that teardrop records through its hooks.
type harness struct {
	Tool  string            // the name in journal lines and records
	Name  string            // as people know it
	Names []string          // what `teardrop setup` accepts for it
	Kinds map[string]string // its event names, mapped to the contract's kinds
	Reply map[string]string // what it needs printed on stdout, per kind
}

// claudeEvents are Claude Code's hook events, which Codex and VS Code's Copilot agent use too.
var claudeEvents = map[string]string{"UserPromptSubmit": "prompt", "Stop": "turn_end", "SessionStart": "session_start", "SessionEnd": "session_end"}

var harnesses = []harness{
	{Tool: "claude-code", Name: "Claude Code", Names: []string{"claude", "claude-code", "claudecode"}, Kinds: claudeEvents},
	{Tool: "codex", Name: "Codex", Names: []string{"codex"}, Kinds: merged(claudeEvents, map[string]string{
		"agent-turn-complete": "turn_end", // from `notify` in config.toml, which needs no trust step
	})},
	{Tool: "amp", Name: "Amp", Names: []string{"amp", "ampcode"}, Kinds: map[string]string{"agent.start": "prompt", "agent.end": "turn_end"}},
	// teardrop's OpenCode plugin names the contract's kinds itself.
	{Tool: "opencode", Name: "OpenCode", Names: []string{"opencode"}, Kinds: map[string]string{"prompt": "prompt", "turn_end": "turn_end"}},
	{Tool: "copilot", Name: "GitHub Copilot", Names: []string{"copilot", "github-copilot"}, Kinds: merged(claudeEvents, map[string]string{
		"userPromptSubmitted": "prompt", "agentStop": "turn_end", "sessionStart": "session_start", "sessionEnd": "session_end",
	})},
	{Tool: "cursor", Name: "Cursor", Names: []string{"cursor"}, Kinds: map[string]string{
		"beforeSubmitPrompt": "prompt", "stop": "turn_end", "sessionStart": "session_start", "sessionEnd": "session_end", "afterFileEdit": "edit",
	}, Reply: map[string]string{"prompt": `{"continue":true}`}},
}

func merged(a, b map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func harnessFor(tool string) *harness {
	for i := range harnesses {
		if harnesses[i].Tool == tool {
			return &harnesses[i]
		}
	}
	return nil
}

// kindOf returns the contract kind of a tool's event, or "" for an event that
// isn't one. A built-in harness may also name a kind directly.
func kindOf(tool, event string) string {
	if h := harnessFor(tool); h != nil && h.Kinds[event] != "" {
		return h.Kinds[event]
	}
	if hookKinds[event] {
		return event
	}
	return ""
}

// turnEnds names, per built-in tool, the hook events after which no more of a
// turn is coming: the reply finished, or was interrupted, or the session
// closed. Amp reports an interrupted turn as agent.end. Claude Code runs no
// hook when a reply is interrupted or fails, so there runHook notices it at
// the next prompt (see turnLeftOpen).
var turnEnds = func() map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for _, h := range harnesses {
		out[h.Tool] = map[string]bool{}
		for ev, k := range h.Kinds {
			if k == "turn_end" || k == "session_end" {
				out[h.Tool][ev] = true
			}
		}
	}
	return out
}()

// setupNames maps the names `teardrop setup` accepts to the tool they mean.
var setupNames = func() map[string]string {
	out := map[string]string{}
	for _, h := range harnesses {
		for _, n := range h.Names {
			out[n] = h.Name
		}
	}
	return out
}()

// ourCommand reports whether command runs teardrop's hook for tool.
func ourCommand(command, tool string) bool {
	return strings.Contains(command, "teardrop") && strings.Contains(command, " hook "+tool)
}

// hookCommandFor is the command a harness runs for tool's event, with
// -event when its payload doesn't name the event.
func hookCommandFor(tool, event string) (string, error) {
	exe, err := teardropPath()
	if err != nil {
		return "", err
	}
	c := `"` + filepath.ToSlash(exe) + `" hook ` + tool
	if event != "" {
		c += " -event " + event
	}
	return c, nil
}

// codexHome is where Codex keeps its settings.
func codexHome() string {
	if d := os.Getenv("CODEX_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

// checkCodex installs or removes teardrop's Codex hooks (~/.codex/hooks.json,
// which Codex runs once the person trusts them in /hooks) and its `notify`
// program in config.toml, which syncs at every turn end with no trust step.
func checkCodex(yes, remove bool) {
	dir := codexHome()
	if !exists(dir) {
		return
	}
	path := filepath.Join(dir, "hooks.json")
	settings, err := readSettings(path)
	if err != nil {
		fmt.Printf("\n  Could not read %s (%v), so Codex hooks were not set up.\n", path, err)
		return
	}
	command := ""
	if !remove {
		if command, err = hookCommandFor("codex", ""); err != nil {
			fmt.Printf("\n  Skipped Codex hooks: %v.\n", err)
			return
		}
	}
	changed, err := setHooksFor(settings, command, "codex", hookEvents, !remove)
	if err != nil {
		fmt.Printf("\n  Could not set up Codex hooks in %s: %v\n", path, err)
		return
	}
	if changed && (remove || yes || confirm("\n  Add teardrop hooks to Codex, so each prompt is recorded as it happens? This edits "+path+" [Y/n] ")) {
		if err := writeSettings(path, settings); err != nil {
			fmt.Printf("  Could not update %s: %v\n", path, err)
			return
		}
		if !remove {
			fmt.Println("  Added. Open Codex, run /hooks, and trust teardrop's hooks: Codex skips new hooks until you do.")
		}
	} else if !changed && !remove {
		fmt.Printf("\n  Codex hooks: installed (%s). If Codex hasn't run them yet, trust them in /hooks.\n", path)
	}
	toml := filepath.Join(dir, "config.toml")
	old, _ := os.ReadFile(toml)
	exe, err := teardropPath()
	if err != nil {
		return
	}
	next, note := setNotify(string(old), filepath.ToSlash(exe), !remove)
	if note != "" {
		fmt.Println("  " + note)
	}
	if next != string(old) {
		if err := os.WriteFile(toml, []byte(next), 0o600); err != nil {
			fmt.Printf("  Could not update %s: %v\n", toml, err)
		} else if !remove {
			fmt.Printf("  Codex now starts a teardrop sync when a turn ends (notify in %s).\n", toml)
		}
	}
}

const notifyMark = "# teardrop: syncs when a Codex turn ends"

// setNotify adds teardrop's `notify` line to a Codex config.toml, above its
// first table so it is a top-level key, when the file has no notify of its
// own; or removes it. It returns the new file and anything to tell the person.
func setNotify(toml, exe string, install bool) (string, string) {
	lines := strings.Split(toml, "\n")
	var kept []string
	theirs := false
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if l == notifyMark {
			i++ // the notify line under the mark
			continue
		}
		if t := strings.TrimSpace(l); strings.HasPrefix(t, "notify") && strings.Contains(t, "=") && strings.TrimSpace(strings.SplitN(t, "=", 2)[0]) == "notify" {
			theirs = true
		}
		kept = append(kept, l)
	}
	if !install {
		return strings.Join(kept, "\n"), ""
	}
	if theirs {
		return toml, "Your Codex config.toml already has a notify program, so teardrop left it alone; trust teardrop's hooks in /hooks instead."
	}
	lit, _ := json.Marshal(exe)
	add := []string{notifyMark, "notify = [" + string(lit) + `, "hook", "codex", "-notify"]`}
	at := len(kept)
	for i, l := range kept {
		if strings.HasPrefix(strings.TrimSpace(l), "[") {
			at = i
			break
		}
	}
	for at > 0 && kept[at-1] == "" {
		at--
	}
	out := append(append(append([]string{}, kept[:at]...), add...), kept[at:]...)
	return strings.Join(out, "\n"), ""
}

// cursorEvents are the Cursor hooks teardrop installs.
var cursorEvents = []string{"beforeSubmitPrompt", "stop", "sessionStart", "sessionEnd", "afterFileEdit"}

// setCursorHooks updates a Cursor hooks.json, {"version":1,"hooks":{event:[{"command":...}]}},
// so it holds teardrop's hooks when install is true or none when it is false,
// keeping every other hook. It returns the new file and whether it changed.
func setCursorHooks(file []byte, command string, install bool) ([]byte, bool, error) {
	var doc map[string]json.RawMessage
	if len(strings.TrimSpace(string(file))) == 0 && !install {
		return file, false, nil // no hooks to remove, and no file to make
	}
	if len(strings.TrimSpace(string(file))) == 0 {
		doc = map[string]json.RawMessage{"version": json.RawMessage("1")}
	} else if err := json.Unmarshal(file, &doc); err != nil || doc == nil {
		return nil, false, errors.New("it has a shape teardrop doesn't recognize")
	}
	hooks := map[string][]map[string]json.RawMessage{}
	if raw, ok := doc["hooks"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &hooks); err != nil {
			return nil, false, errors.New(`its "hooks" have a shape teardrop doesn't recognize`)
		}
	}
	for ev, hs := range hooks {
		var kept []map[string]json.RawMessage
		for _, h := range hs {
			var c string
			json.Unmarshal(h["command"], &c)
			if !ourCommand(c, "cursor") {
				kept = append(kept, h)
			}
		}
		if len(kept) > 0 {
			hooks[ev] = kept
		} else {
			delete(hooks, ev)
		}
	}
	if install {
		c, _ := json.Marshal(command)
		for _, ev := range cursorEvents {
			hooks[ev] = append(hooks[ev], map[string]json.RawMessage{"command": c})
		}
	}
	doc["hooks"], _ = json.Marshal(hooks)
	next, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, false, err
	}
	return append(next, '\n'), !sameJSON(file, next), nil
}

// copilotEvents are the Copilot CLI hooks teardrop installs. Their payload
// doesn't name the event, so each command does.
var copilotEvents = []string{"userPromptSubmitted", "agentStop", "sessionStart", "sessionEnd"}

// copilotHooks is the whole of ~/.copilot/hooks/teardrop.json, which only teardrop writes.
func copilotHooks(exe string) []byte {
	hooks := map[string][]map[string]any{}
	for _, ev := range copilotEvents {
		bash := `"` + filepath.ToSlash(exe) + `" hook copilot -event ` + ev
		hooks[ev] = []map[string]any{{"type": "command", "bash": bash, "powershell": "& " + bash, "timeoutSec": 10}}
	}
	b, _ := json.MarshalIndent(map[string]any{"version": 1, "hooks": hooks}, "", "  ")
	return append(b, '\n')
}

// checkFileHooks installs or removes teardrop's hooks for Cursor and Copilot,
// for each that is installed here.
func checkFileHooks(only func(string) bool, yes, remove bool) {
	home, _ := os.UserHomeDir()
	exe, err := teardropPath()
	if err != nil && !remove {
		return
	}
	if dir := filepath.Join(home, ".cursor"); only("Cursor") && exists(dir) {
		path := filepath.Join(dir, "hooks.json")
		old, _ := os.ReadFile(path)
		next, changed, err := setCursorHooks(old, `"`+filepath.ToSlash(exe)+`" hook cursor`, !remove)
		switch {
		case err != nil:
			fmt.Printf("\n  Could not set up Cursor hooks in %s: %v\n", path, err)
		case !changed && !remove:
			fmt.Printf("\n  Cursor hooks: installed (%s)\n", path)
		case changed && (remove || yes || confirm("\n  Add teardrop hooks to Cursor? This edits "+path+" [Y/n] ")):
			if err := os.WriteFile(path, next, 0o600); err != nil {
				fmt.Printf("  Could not update %s: %v\n", path, err)
			} else if !remove {
				fmt.Println("  Added. Restart Cursor to load them.")
			}
		}
	}
	if dir := filepath.Join(home, ".copilot"); only("GitHub Copilot") && exists(dir) {
		path := filepath.Join(dir, "hooks", "teardrop.json")
		if remove {
			os.Remove(path)
			return
		}
		want := copilotHooks(exe)
		if old, _ := os.ReadFile(path); string(old) == string(want) {
			fmt.Printf("\n  Copilot hooks: installed (%s)\n", path)
			return
		}
		if !yes && !confirm("\n  Add teardrop hooks to GitHub Copilot? This writes "+path+" [Y/n] ") {
			return
		}
		os.MkdirAll(filepath.Dir(path), 0o700)
		if err := os.WriteFile(path, want, 0o600); err != nil {
			fmt.Printf("  Could not write %s: %v\n", path, err)
		} else {
			fmt.Println("  Added. New Copilot sessions will use them.")
		}
	}
}
