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
//	helios hook <tool> [-event <kind>]
//
// with JSON on stdin: session_id, cwd, the event (hook_event_name, or the
// -event flag), and optionally prompt, time, tokens_in, tokens_out,
// lines_added, and lines_removed. The kinds are prompt, turn_end,
// session_start, session_end, and edit. Any tool name that matches toolName
// is accepted. helios exits 0, prints only the reply its adapter declares,
// and keeps no prompt text. The harnesses below are built in: each maps its
// own event names and payload onto the contract.

// toolName is what a harness may call itself.
var toolName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// kinds are the contract's events.
var hookKinds = map[string]bool{"prompt": true, "turn_end": true, "session_start": true, "session_end": true, "edit": true}

// harness is one AI coding tool that helios records through its hooks.
type harness struct {
	Tool  string            // the name in journal lines and records
	Name  string            // as people know it
	Names []string          // what `helios setup` accepts for it
	Kinds map[string]string // its event names, mapped to the contract's kinds
	Reply map[string]string // what it needs printed on stdout, per kind
	Ack   string            // what it needs printed on stdout on every run, even one helios doesn't record
}

// claudeEvents are Claude Code's hook events, which Codex and VS Code's Copilot agent use too.
var claudeEvents = map[string]string{"UserPromptSubmit": "prompt", "Stop": "turn_end", "SessionStart": "session_start", "SessionEnd": "session_end"}

var harnesses = []harness{
	{Tool: "claude-code", Name: "Claude Code", Names: []string{"claude", "claude-code", "claudecode"}, Kinds: claudeEvents},
	{Tool: "codex", Name: "Codex", Names: []string{"codex"}, Kinds: merged(claudeEvents, map[string]string{
		"agent-turn-complete": "turn_end", // from `notify` in config.toml, which needs no trust step
	})},
	{Tool: "amp", Name: "Amp", Names: []string{"amp", "ampcode"}, Kinds: map[string]string{"agent.start": "prompt", "agent.end": "turn_end"}},
	// helios's OpenCode plugin names the contract's kinds itself.
	{Tool: "opencode", Name: "OpenCode", Names: []string{"opencode"}, Kinds: map[string]string{"prompt": "prompt", "turn_end": "turn_end"}},
	{Tool: "copilot", Name: "GitHub Copilot", Names: []string{"copilot", "github-copilot"}, Kinds: merged(claudeEvents, map[string]string{
		"userPromptSubmitted": "prompt", "agentStop": "turn_end", "sessionStart": "session_start", "sessionEnd": "session_end",
	})},
	{Tool: "cursor", Name: "Cursor", Names: []string{"cursor"}, Kinds: map[string]string{
		"beforeSubmitPrompt": "prompt", "stop": "turn_end", "sessionStart": "session_start", "sessionEnd": "session_end", "afterFileEdit": "edit",
	}, Reply: map[string]string{"prompt": `{"continue":true}`}},
	// Antigravity's hooks name no event, so each passes -event (antigravity.go).
	{Tool: "antigravity", Name: "Antigravity", Names: []string{"antigravity", "agy"}, Kinds: map[string]string{
		"SessionStart": "session_start", "PreInvocation": "prompt", "Stop": "turn_end",
	}, Ack: "{}"},
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

// setupNames maps the names `helios setup` accepts to the tool they mean.
var setupNames = func() map[string]string {
	out := map[string]string{}
	for _, h := range harnesses {
		for _, n := range h.Names {
			out[n] = h.Name
		}
	}
	return out
}()

// ourCommand reports whether command runs helios's hook for tool.
func ourCommand(command, tool string) bool {
	return strings.Contains(command, "helios") && strings.Contains(command, " hook "+tool)
}

// hookCommandFor is the command a harness runs for tool's event, with
// -event when its payload doesn't name the event.
func hookCommandFor(tool, event string) (string, error) {
	exe, err := heliosPath()
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

// checkCodex installs or removes helios's Codex hooks (~/.codex/hooks.json,
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
		fmt.Printf(txtCodexUnreadable, path, err)
		return
	}
	command := ""
	if !remove {
		if command, err = hookCommandFor("codex", ""); err != nil {
			fmt.Printf(txtCodexSkipped, err)
			return
		}
	}
	changed, err := setHooksFor(settings, command, "codex", hookEvents, !remove)
	if err != nil {
		fmt.Printf(txtCodexSetupFailed, path, err)
		return
	}
	if changed && (remove || yes || confirm(fmt.Sprintf(txtCodexConfirm, path))) {
		if err := writeSettings(path, settings); err != nil {
			fmt.Printf(txtCouldNotUpdate, path, err)
			return
		}
		if !remove {
			fmt.Print(txtCodexAdded)
		}
	} else if !changed && !remove {
		fmt.Printf(txtCodexInstalled, path)
	}
	toml := filepath.Join(dir, "config.toml")
	old, _ := os.ReadFile(toml)
	exe, err := heliosPath()
	if err != nil {
		return
	}
	next, note := setNotify(string(old), filepath.ToSlash(exe), !remove)
	if note != "" {
		fmt.Println("  " + note)
	}
	if next != string(old) {
		if err := os.WriteFile(toml, []byte(next), 0o600); err != nil {
			fmt.Printf(txtCouldNotUpdate, toml, err)
		} else if !remove {
			fmt.Printf(txtCodexNotifyAdded, toml)
		}
	}
}

const notifyMark = "# helios: syncs when a Codex turn ends"

// setNotify adds helios's `notify` line to a Codex config.toml, above its
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
		return toml, txtCodexNotifyTheirs
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

// cursorEvents are the Cursor hooks helios installs.
var cursorEvents = []string{"beforeSubmitPrompt", "stop", "sessionStart", "sessionEnd", "afterFileEdit"}

// setCursorHooks updates a Cursor hooks.json, {"version":1,"hooks":{event:[{"command":...}]}},
// so it holds helios's hooks when install is true or none when it is false,
// keeping every other hook. It returns the new file and whether it changed.
func setCursorHooks(file []byte, command string, install bool) ([]byte, bool, error) {
	var doc map[string]json.RawMessage
	if len(strings.TrimSpace(string(file))) == 0 && !install {
		return file, false, nil // no hooks to remove, and no file to make
	}
	if len(strings.TrimSpace(string(file))) == 0 {
		doc = map[string]json.RawMessage{"version": json.RawMessage("1")}
	} else if err := json.Unmarshal(file, &doc); err != nil || doc == nil {
		return nil, false, errors.New(txtUnknownShape)
	}
	hooks := map[string][]map[string]json.RawMessage{}
	if raw, ok := doc["hooks"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &hooks); err != nil {
			return nil, false, errors.New(txtUnknownHooksShape)
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

// copilotEvents are the Copilot CLI hooks helios installs. Their payload
// doesn't name the event, so each command does.
var copilotEvents = []string{"userPromptSubmitted", "agentStop", "sessionStart", "sessionEnd"}

// copilotHooks is the whole of ~/.copilot/hooks/helios.json, which only helios writes.
func copilotHooks(exe string) []byte {
	hooks := map[string][]map[string]any{}
	for _, ev := range copilotEvents {
		bash := `"` + filepath.ToSlash(exe) + `" hook copilot -event ` + ev
		hooks[ev] = []map[string]any{{"type": "command", "bash": bash, "powershell": "& " + bash, "timeoutSec": 10}}
	}
	b, _ := json.MarshalIndent(map[string]any{"version": 1, "hooks": hooks}, "", "  ")
	return append(b, '\n')
}

// checkFileHooks installs or removes helios's hooks for Cursor and Copilot,
// for each that is installed here.
func checkFileHooks(only func(string) bool, yes, remove bool) {
	home, _ := os.UserHomeDir()
	exe, err := heliosPath()
	if err != nil && !remove {
		return
	}
	if dir := filepath.Join(home, ".cursor"); only("Cursor") && exists(dir) {
		path := filepath.Join(dir, "hooks.json")
		old, _ := os.ReadFile(path)
		next, changed, err := setCursorHooks(old, `"`+filepath.ToSlash(exe)+`" hook cursor`, !remove)
		switch {
		case err != nil:
			fmt.Printf(txtCursorSetupFailed, path, err)
		case !changed && !remove:
			fmt.Printf(txtCursorInstalled, path)
		case changed && (remove || yes || confirm(fmt.Sprintf(txtCursorConfirm, path))):
			if err := os.WriteFile(path, next, 0o600); err != nil {
				fmt.Printf(txtCouldNotUpdate, path, err)
			} else if !remove {
				fmt.Print(txtCursorAdded)
			}
		}
	}
	if dir := filepath.Join(home, ".copilot"); only("GitHub Copilot") && exists(dir) {
		checkCopilot(dir, exe, yes, remove)
	}
}

// checkCopilot installs, updates, or removes helios's hooks file in
// Copilot's folder, and says which it did.
func checkCopilot(dir, exe string, yes, remove bool) {
	path := filepath.Join(dir, "hooks", "helios.json")
	if remove {
		switch err := os.Remove(path); {
		case err == nil:
			fmt.Printf(txtCopilotRemoved, path)
		case !errors.Is(err, os.ErrNotExist):
			fmt.Printf(txtCouldNotRemove, path, err)
		}
		return
	}
	want := copilotHooks(exe)
	old, err := os.ReadFile(path)
	had := err == nil
	if string(old) == string(want) {
		fmt.Printf(txtCopilotInstalled, path)
		return
	}
	if !had && !yes && !confirm(fmt.Sprintf(txtCopilotConfirm, path)) {
		fmt.Print(txtSkippedRerun)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		fmt.Printf(txtCouldNotWriteNL, path, err)
		return
	}
	switch err := os.WriteFile(path, want, 0o600); {
	case err != nil:
		fmt.Printf(txtCouldNotWriteNL, path, err)
	case had:
		fmt.Printf(txtUpdatedHookPath, path)
	default:
		fmt.Print(txtCopilotAdded)
	}
}
