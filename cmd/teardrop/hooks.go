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
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/textscore"
)

// hookEvents are the Claude Code events teardrop records. Tool calls are left
// out on purpose: a hook on every tool call would slow Claude Code down on old
// laptops, and the gap between a prompt and Stop already covers agent work.
var hookEvents = []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"}

const hookArgs = "hook claude-code"

// turnLeftOpen reports whether the last thing the journal holds for a session
// is a prompt. When the next event is a prompt too, the turn between them
// ended without a hook saying so: it was interrupted, or it failed.
func turnLeftOpen(dir, tool, session string, now time.Time) bool {
	last, found := sources.LastJournalEvent(dir, now, tool, session)
	return found && last.Human
}

// hookInput is what a harness hands a hook on stdin: the contract's fields,
// and the names the built-in harnesses use for them.
type hookInput struct {
	SessionID    string   `json:"session_id"`
	SessionID2   string   `json:"sessionId"`
	Conversation string   `json:"conversation_id"` // Cursor
	Thread       string   `json:"thread-id"`       // Codex notify
	Cwd          string   `json:"cwd"`
	Roots        []string `json:"workspace_roots"` // Cursor
	Event        string   `json:"hook_event_name"`
	Event2       string   `json:"hookEventName"`
	Type         string   `json:"type"` // Codex notify
	Prompt       string   `json:"prompt"`
	Time         string   `json:"time"` // when it happened, if the plugin hands it over late
	// What the model read and wrote in the turn that this event ends.
	TokensIn     int64 `json:"tokens_in"`
	TokensOut    int64 `json:"tokens_out"`
	LinesAdded   int   `json:"lines_added"`
	LinesRemoved int   `json:"lines_removed"`
	Edits        []struct {
		Old string `json:"old_string"`
		New string `json:"new_string"`
	} `json:"edits"` // Cursor's afterFileEdit
}

// hookRecord turns one hook payload into a journal event and its kind. ok is
// false for a payload that is not an event of the contract.
func hookRecord(tool, event string, in hookInput, now time.Time) (ev sources.JournalEvent, kind string, ok bool) {
	if event == "" {
		event = first(in.Event, in.Event2, in.Type)
	}
	kind = kindOf(tool, event)
	if harnessFor(tool) == nil && kind == "" || event == "" {
		return ev, "", false
	}
	cwd := in.Cwd
	if cwd == "" && len(in.Roots) > 0 {
		cwd = in.Roots[0]
	}
	session := first(in.SessionID, in.SessionID2, in.Conversation, in.Thread)
	if session == "" && cwd != "" {
		session = "cwd:" + cwd // Copilot CLI's payload names no session
	}
	if session == "" {
		return ev, "", false
	}
	// Claude Code may hand its prompt hook text it wrote itself, such as a
	// background task's notice: that is the agent at work, not a prompt.
	ev = sources.JournalEvent{Time: now.UTC(), Tool: tool, Event: event, Session: session, Cwd: cwd, Human: kind == "prompt" && !sources.Injected(in.Prompt)}
	if ev.Human {
		s := textscore.Analyze(in.Prompt)
		ev.Judged, ev.Real, ev.Sim, ev.Low = s.Judged, s.Real, uint64(s.Sim), s.Low
		// Words the dictionary lacks may be the project's own, if a sync saved them.
		if len(s.Unknown) > 0 {
			ev.Real += vocabHits(savedRoot(cwd), s.Unknown)
		}
	} else {
		ev.In, ev.Out = max(0, in.TokensIn), max(0, in.TokensOut)
		ev.Added, ev.Removed = max(0, in.LinesAdded), max(0, in.LinesRemoved)
		for _, e := range in.Edits {
			a, r := sources.CountLines(e.Old, e.New)
			ev.Added, ev.Removed = ev.Added+a, ev.Removed+r
		}
	}
	return ev, kind, true
}

func first(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

// runHook records one hook event (see the contract in adapters.go). It must
// never get in the tool's way: it prints only what the harness needs (on
// Claude Code's UserPromptSubmit anything would reach the model), always
// exits 0, and keeps no prompt text.
//
// The event goes to this machine's journal and, when a site is set, to the
// relay outbox, which `teardrop relay` sends in the background. With -relay,
// the event goes only to the site, and a turn that ends has the person's
// cloud threads counted (cloud.go); Amp's cloud plugin uses it. With -notify
// (Codex's notify program), the payload is the last argument. With -check,
// it prints the record a payload makes and writes nothing.
func runHook(args []string) {
	check := false
	defer func() {
		if r := recover(); r != nil && check {
			fmt.Println("teardrop hook:", r)
		}
	}()
	var tool, event, payload string
	relay, notify := false, false
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "-relay":
			relay = true
		case a == "-notify":
			notify = true
		case a == "-check":
			check = true
		case a == "-event" && i+1 < len(args):
			i++
			event = args[i]
		case tool == "":
			tool = a
		default:
			payload = a
		}
	}
	if !toolName.MatchString(tool) {
		if check {
			fmt.Printf("teardrop hook: %q is not a tool name; use lowercase letters, digits, and dashes\n", tool)
		}
		return
	}
	var b []byte
	if notify {
		b = []byte(payload)
	} else {
		b, _ = io.ReadAll(io.LimitReader(os.Stdin, 32<<20))
	}
	var in hookInput
	if json.Unmarshal(b, &in) != nil {
		if check {
			fmt.Println("teardrop hook: stdin is not a JSON object")
		}
		return
	}
	ev, kind, ok := hookRecord(tool, event, in, time.Now())
	if check {
		if !ok {
			fmt.Println("teardrop hook: not recorded: it needs a session_id and an event that is one of prompt, turn_end, session_start, session_end, or edit")
			return
		}
		rec, _ := json.Marshal(ev)
		fmt.Printf("kind: %s\nrecord: %s\n", kind, rec)
		if h := harnessFor(tool); h != nil && h.Reply[kind] != "" {
			fmt.Printf("stdout: %s\n", h.Reply[kind])
		}
		return
	}
	if h := harnessFor(tool); h != nil && h.Reply[kind] != "" {
		fmt.Println(h.Reply[kind])
	}
	if !ok {
		return
	}
	ended := kind == "turn_end" || kind == "session_end"
	if relay {
		ev.Time = happenedAt(ev.Time, in.Time)
		// The thread that counts this event may run on another machine, which
		// can't look the folder up, so the repository goes with it, without
		// any sign-in the remote holds.
		if remote := gitOut(ev.Cwd, "config", "--get", "remote.origin.url"); remote != "" {
			ev.Git = normalizeRemote(remote)
		}
		if err := queueRelay(relayOutbox, ev); err != nil {
			fmt.Fprintln(os.Stderr, "teardrop hook:", err)
		}
		relaySoon(ended)
		return
	}
	// Looked up before this event is written, which would otherwise be the last.
	interrupted := ev.Human && turnLeftOpen(dataDir(), tool, ev.Session, ev.Time)
	if err := sources.AppendJournal(dataDir(), ev); err != nil {
		fmt.Fprintln(os.Stderr, "teardrop hook:", err)
	}
	// The site gets the record as it happens, so it can witness it: with the
	// project's key in place of the folder.
	if _, err := os.Stat(filepath.Join(dataDir(), "server")); err == nil {
		p, _ := resolveProject(ev.Cwd, "")
		ev.Git, ev.Cwd = p.Key, ""
		if queueRelay(localOutbox, ev) == nil {
			relaySoon(false)
		}
	}
	syncSoon(turnEnds[tool][ev.Event] || ended || interrupted || notify)
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
func isOurs(h map[string]json.RawMessage, tool string) bool {
	var c string
	json.Unmarshal(h["command"], &c)
	return ourCommand(c, tool)
}

// setHooks updates the "hooks" setting so it holds teardrop's hooks with
// command when install is true, or none when it is false, keeping every other
// hook as it was. It reports whether the setting changed.
func setHooks(settings map[string]json.RawMessage, command string, install bool) (bool, error) {
	return setHooksFor(settings, command, "claude-code", hookEvents, install)
}

// setHooksFor does what setHooks does, for a harness whose hooks file has
// Claude Code's shape, such as Codex's hooks.json.
func setHooksFor(settings map[string]json.RawMessage, command, tool string, events []string, install bool) (bool, error) {
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
				if !isOurs(h, tool) {
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
		for _, e := range events {
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
