package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/textscore"
)

// hookEvents are the Claude Code events teardrop records. Tool calls are left
// out on purpose: a hook on every tool call would slow Claude Code down on old
// laptops, and the gap between a prompt and Stop already covers agent work.
var hookEvents = []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"}

const hookArgs = "hook claude-code"

// humanEvents names, per tool, the hook event that means a person sent a prompt.
var humanEvents = map[string]string{
	"claude-code": "UserPromptSubmit", // Claude Code hooks
	"amp":         "agent.start",      // the Amp plugin
}

// turnEnds names, per tool, the hook events after which no more of a turn
// is coming: the reply finished, or was interrupted, or the session closed.
// Amp reports an interrupted turn as agent.end. Claude Code runs no hook when
// a reply is interrupted or fails, so there runHook notices it at the next
// prompt (see turnLeftOpen).
var turnEnds = map[string]map[string]bool{
	"claude-code": {"Stop": true, "SessionEnd": true},
	"amp":         {"agent.end": true},
}

// turnLeftOpen reports whether the last thing the journal holds for a session
// is a prompt. When the next event is a prompt too, the turn between them
// ended without a hook saying so: it was interrupted, or it failed.
func turnLeftOpen(dir, tool, session string, now time.Time) bool {
	last, found := sources.LastJournalEvent(dir, now, tool, session)
	return found && last.Human
}

// runHook records one hook event from stdin. It must never get in the tool's
// way: it prints nothing to stdout (on Claude Code's UserPromptSubmit that
// would reach the model), always exits 0, and keeps no prompt text.
//
// With -relay after the tool, the event goes to the person's teardrop site
// instead of this machine's journal, and a turn that ends, finished or
// interrupted, has the person's cloud threads counted (cloud.go). Amp's cloud
// plugin uses it.
func runHook(args []string) {
	defer func() { recover() }()
	if len(args) == 0 || humanEvents[args[0]] == "" {
		return
	}
	tool := args[0]
	relay := len(args) > 1 && args[1] == "-relay"
	var in struct {
		SessionID string `json:"session_id"`
		Cwd       string `json:"cwd"`
		Event     string `json:"hook_event_name"`
		Prompt    string `json:"prompt"`
		Time      string `json:"time"` // when it happened, if the plugin hands it over late
		// What the model read and wrote in the turn that this event ends, from the Amp plugins.
		TokensIn  int64 `json:"tokens_in"`
		TokensOut int64 `json:"tokens_out"`
	}
	b, _ := io.ReadAll(io.LimitReader(os.Stdin, 32<<20))
	if json.Unmarshal(b, &in) != nil || in.SessionID == "" || in.Event == "" {
		return
	}
	ev := sources.JournalEvent{
		Time: time.Now().UTC(), Tool: tool, Event: in.Event,
		Session: in.SessionID, Cwd: in.Cwd, Human: in.Event == humanEvents[tool],
	}
	if !ev.Human {
		ev.In, ev.Out = max(0, in.TokensIn), max(0, in.TokensOut)
	}
	if ev.Human {
		s := textscore.Analyze(in.Prompt)
		ev.Judged, ev.Real, ev.Sim, ev.Low = s.Judged, s.Real, uint64(s.Sim), s.Low
	}
	if relay {
		ev.Time = happenedAt(ev.Time, in.Time)
		// The thread that counts this event may run on another machine, which
		// can't look the folder up, so the repository goes with it, without
		// any sign-in the remote holds.
		if remote := gitOut(in.Cwd, "config", "--get", "remote.origin.url"); remote != "" {
			ev.Git = normalizeRemote(remote)
		}
		if err := queueRelay(ev); err != nil {
			fmt.Fprintln(os.Stderr, "teardrop hook:", err)
		}
		relaySoon(in.Event == "agent.end")
		return
	}
	// Looked up before this event is written, which would otherwise be the last.
	interrupted := ev.Human && turnLeftOpen(dataDir(), tool, ev.Session, ev.Time)
	if err := sources.AppendJournal(dataDir(), ev); err != nil {
		fmt.Fprintln(os.Stderr, "teardrop hook:", err)
	}
	syncSoon(turnEnds[tool][in.Event] || interrupted)
}

// dataDir is where teardrop keeps its own records, such as the hook journal.
func dataDir() string {
	if d := os.Getenv("TEARDROP_DATA_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "teardrop")
		}
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "teardrop")
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "teardrop")
	}
	return filepath.Join(home, ".local", "share", "teardrop")
}

// hookCommand is the command Claude Code runs: this binary's absolute path.
// Forward slashes work in the Git Bash that Claude Code uses on Windows.
func hookCommand() (string, error) {
	exe, err := teardropPath()
	if err != nil {
		return "", err
	}
	return `"` + filepath.ToSlash(exe) + `" ` + hookArgs, nil
}

// isOurs reports whether a hook entry runs teardrop's hook command.
func isOurs(h map[string]json.RawMessage) bool {
	var c string
	json.Unmarshal(h["command"], &c)
	return strings.Contains(c, "teardrop") && strings.HasSuffix(strings.TrimSpace(c), hookArgs)
}

// setHooks updates the "hooks" setting so it holds teardrop's hooks with
// command when install is true, or none when it is false, keeping every other
// hook as it was. It reports whether the setting changed.
func setHooks(settings map[string]json.RawMessage, command string, install bool) (bool, error) {
	hooks := map[string][]map[string]json.RawMessage{}
	raw, had := settings["hooks"]
	if had && string(raw) != "null" {
		if err := json.Unmarshal(raw, &hooks); err != nil {
			return false, errors.New(`its "hooks" setting has a shape teardrop doesn't recognize`)
		}
	}
	for event, groups := range hooks {
		var kept []map[string]json.RawMessage
		for _, g := range groups {
			var hs []map[string]json.RawMessage
			if json.Unmarshal(g["hooks"], &hs) != nil {
				kept = append(kept, g)
				continue
			}
			var others []map[string]json.RawMessage
			for _, h := range hs {
				if !isOurs(h) {
					others = append(others, h)
				}
			}
			if len(others) == len(hs) {
				kept = append(kept, g)
			} else if len(others) > 0 {
				g["hooks"], _ = json.Marshal(others)
				kept = append(kept, g)
			}
		}
		if len(kept) > 0 {
			hooks[event] = kept
		} else {
			delete(hooks, event)
		}
	}
	if install {
		ours, _ := json.Marshal([]map[string]any{{"type": "command", "command": command, "timeout": 10}})
		for _, e := range hookEvents {
			hooks[e] = append(hooks[e], map[string]json.RawMessage{"hooks": ours})
		}
	}
	if len(hooks) == 0 && !had {
		return false, nil
	}
	next, err := json.Marshal(hooks)
	if err != nil {
		return false, err
	}
	changed := !sameJSON(raw, next)
	settings["hooks"] = next
	return changed, nil
}

func sameJSON(a, b []byte) bool {
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}

// checkHooks installs, updates, or removes teardrop's hooks in one Claude Code config dir.
func checkHooks(dir string, yes, remove bool) {
	path := filepath.Join(dir, "settings.json")
	settings, err := readSettings(path)
	if err != nil {
		fmt.Printf("\n  Could not read %s (%v), so Claude Code hooks were not set up.\n", path, err)
		return
	}
	hadOurs, _ := setHooks(maps.Clone(settings), "", false)
	command := ""
	if !remove {
		if command, err = hookCommand(); err != nil {
			fmt.Printf("\n  Skipped Claude Code hooks: %v.\n", err)
			return
		}
	}
	changed, err := setHooks(settings, command, !remove)
	if err != nil {
		fmt.Printf("\n  Could not set up Claude Code hooks in %s: %v\n", path, err)
		return
	}
	switch {
	case !changed && !remove:
		fmt.Printf("\n  Claude Code hooks: installed (%s)\n", path)
		return
	case !changed:
		return
	case !remove && !hadOurs:
		fmt.Println("\n  Add teardrop hooks to Claude Code? When you send a prompt or Claude finishes,")
		fmt.Printf("  they record the time and folder (never the prompt text) in %s,\n", dataDir())
		fmt.Println("  so your history is kept even if Claude Code deletes its transcripts.")
		if !yes && !confirm("  This edits "+path+" [Y/n] ") {
			fmt.Println("  Skipped. Run `teardrop setup` again to change your mind.")
			return
		}
	}
	if err := writeSettings(path, settings); err != nil {
		fmt.Printf("  Could not update %s: %v\n", path, err)
		return
	}
	switch {
	case remove:
		fmt.Printf("\n  Removed teardrop hooks from %s\n", path)
	case hadOurs:
		fmt.Printf("\n  Updated the teardrop hook path in %s\n", path)
	default:
		fmt.Println("  Added. New Claude Code sessions will use them.")
	}
}
