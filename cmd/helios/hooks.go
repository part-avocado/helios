package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
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

	"github.com/part-avocado/helios/internal/sources"
	"github.com/part-avocado/helios/internal/textscore"
	"github.com/part-avocado/helios/internal/timeline"
)

// hookEvents are the Claude Code events helios records. Tool calls are left
// out on purpose: a hook on every tool call would slow Claude Code down on old
// laptops, and the gap between a prompt and Stop already covers agent work.
var hookEvents = []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"}

const hookArgs = "hook claude-code"

// A committed project hook is told apart from a person's own by this flag.
const projectFlag = "-project"

// sameHook is how close two records of one event of one session must be to
// be one event that two hooks reported.
const sameHook = 2 * time.Second

// userHooked reports whether the person's own Claude Code settings, in any of
// its config folders, already run helios's hook. A repository's committed
// hook then stands down, or each event would be recorded twice.
func userHooked() bool {
	for _, loc := range locations("", "") {
		if loc.Tool != "Claude Code" {
			continue
		}
		settings, err := readSettings(filepath.Join(loc.Dir, "settings.json"))
		if err != nil {
			continue
		}
		var hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		}
		if json.Unmarshal(settings["hooks"], &hooks) != nil {
			continue
		}
		for _, groups := range hooks {
			for _, g := range groups {
				for _, h := range g.Hooks {
					// A repository in the home folder has its own hooks in ~/.claude; those are not the person's.
					if ourCommand(h.Command, "claude-code") && !strings.Contains(h.Command, " "+projectFlag) {
						return true
					}
				}
			}
		}
	}
	return false
}

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
	AgyID        string   `json:"conversationId"`  // Antigravity
	Workspaces   []string `json:"workspacePaths"`  // Antigravity
	LastInput    string   `json:"lastUserInput"`   // Antigravity
	Invocation   *int     `json:"invocationNum"`   // Antigravity's PreInvocation: which model call of the execution
	Event        string   `json:"hook_event_name"`
	Event2       string   `json:"hookEventName"`
	Type         string   `json:"type"` // Codex notify
	Prompt       string   `json:"prompt"`
	Time         string   `json:"time"`            // when it happened, if the plugin hands it over late
	Transcript   string   `json:"transcript_path"` // Claude Code's: the session file, read in the cloud for the turn's usage
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
	// Antigravity runs PreInvocation before every model call; only the first
	// of an execution follows a person's prompt.
	if tool == "antigravity" && kind == "prompt" && in.Invocation != nil && *in.Invocation > 0 {
		return ev, "", false
	}
	if in.Prompt == "" && kind == "prompt" {
		in.Prompt = in.LastInput
	}
	cwd := in.Cwd
	if cwd == "" && len(in.Roots) > 0 {
		cwd = in.Roots[0]
	}
	if cwd == "" && len(in.Workspaces) > 0 {
		cwd = in.Workspaces[0]
	}
	session := first(in.SessionID, in.SessionID2, in.Conversation, in.AgyID, in.Thread)
	if session == "" && cwd != "" {
		// Copilot CLI's payload names no session, so its folder stands in for
		// one: hashed, since the session's name goes to the site.
		session = folderSession(cwd)
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

// folderSession names the session of a harness that names none, by the folder
// it runs in.
func folderSession(cwd string) string {
	sum := sha256.Sum256([]byte(cwd))
	return "cwd-" + hex.EncodeToString(sum[:8])
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
// relay outbox, which `helios relay` sends in the background. With -relay,
// the event goes only to the site, and a turn that ends has the person's
// cloud threads counted (cloud.go); Amp's cloud plugin uses it. With -notify
// (Codex's notify program), the payload is the last argument. With -check,
// it prints the record a payload makes and writes nothing. With -project,
// which a repository's committed hooks pass, it does nothing where the
// person's own Claude Code settings already run helios's hook.
func runHook(args []string) {
	check := false
	defer func() {
		if r := recover(); r != nil && check {
			fmt.Println(txtHookPrefix, r)
		}
	}()
	var tool, event, payload string
	relay, notify, project := false, false, false
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == projectFlag:
			project = true
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
	if cloudEnv() {
		relay = true
	}
	if !toolName.MatchString(tool) {
		if check {
			fmt.Printf(txtHookBadTool, tool)
		}
		return
	}
	// A harness that needs an answer on every run gets it, whatever happens next.
	if h := harnessFor(tool); h != nil && h.Ack != "" && !check {
		fmt.Println(h.Ack)
	}
	// A repository's hook, where the person's own settings run helios too:
	// theirs records the event. For Claude Code that is told from its settings
	// (userHooked). Another tool's repository hooks record only on a cloud
	// machine, since on a person's computers that tool's own hooks do.
	if project && !check && (tool == "claude-code" && userHooked() || tool != "claude-code" && !cloudEnv()) {
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
			fmt.Print(txtHookNotJSON)
		}
		return
	}
	ev, kind, ok := hookRecord(tool, event, in, time.Now())
	// There is no sync in the cloud to read the transcript later, so the turn's
	// end sends the turn's usage. It goes as a usage record at the time of the
	// turn's prompt, which the site replaces when it is sent again: a turn that
	// stops twice, as after a background task's notice or a Stop hook that
	// sends it on, is counted once. The turn end itself carries no tokens.
	var usage *sources.JournalEvent
	if ok && kind == "turn_end" && !check && cloudEnv() && tool == "claude-code" && in.Transcript != "" && ev.In+ev.Out == 0 {
		if at, in, out, added, removed := lastTurnUsage(in.Transcript); !at.IsZero() && (in+out > 0 || added+removed > 0) {
			usage = &sources.JournalEvent{Time: at.UTC(), Tool: tool, Event: "usage", Session: ev.Session, In: in, Out: out, Added: added, Removed: removed}
		}
	}
	if check {
		if !ok {
			fmt.Print(txtHookNotRecorded)
			return
		}
		rec, _ := json.Marshal(ev)
		fmt.Printf(txtHookCheck, kind, rec)
		if h := harnessFor(tool); h != nil && h.Reply[kind] != "" {
			fmt.Printf(txtHookCheckStdout, h.Reply[kind])
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
			ev.Git = nameProject(ev.Cwd, remote).Key
		}
		// The repository's key says which project it is; the folder's path on
		// this machine goes only when there is no key.
		root := ev.Cwd
		if ev.Git != "" {
			ev.Cwd = ""
		}
		if err := queueRelay(relayOutbox, ev); err != nil {
			fmt.Fprintln(os.Stderr, txtHookPrefix, err)
		}
		if usage != nil {
			usage.Cwd, usage.Git = ev.Cwd, ev.Git
			if err := queueRelay(relayOutbox, *usage); err != nil {
				fmt.Fprintln(os.Stderr, txtHookPrefix, err)
			}
		}
		// There is no sync in the cloud to send commits, so the turn's end does.
		if ended {
			queueRelayCommits(root, ev.Git, time.Now())
		}
		// Counting cloud threads is Amp's; it would only fail for other tools.
		relaySoon(ended && tool == "amp")
		return
	}
	// Looked up before this event is written, which would otherwise be the last.
	last, found := sources.LastJournalEvent(dataDir(), ev.Time, tool, ev.Session)
	// The same event again within moments is a second hook reporting it, such
	// as a repository's hooks from before they stood down for the person's own.
	// Only Claude Code's: its events come one to a turn, where another
	// harness may report several edits in a moment.
	if tool == "claude-code" && repeatedHook(last, found, ev) {
		return
	}
	interrupted := ev.Human && found && last.Human
	if err := sources.AppendJournal(dataDir(), ev); err != nil {
		fmt.Fprintln(os.Stderr, txtHookPrefix, err)
	}
	// The site gets the record as it happens, so it can witness it: with the
	// project's key in place of the folder.
	if siteSet() {
		p, _ := resolveProject(ev.Cwd, "")
		ev.Git, ev.Cwd = p.Key, ""
		if queueRelay(localOutbox, ev) == nil {
			relaySoon(false)
		}
	}
	syncSoon(turnEnds[tool][ev.Event] || ended || interrupted || notify)
}

// repeatedHook reports whether ev is the event the journal last holds for its
// session, reported again within sameHook.
func repeatedHook(last sources.JournalEvent, found bool, ev sources.JournalEvent) bool {
	d := ev.Time.Sub(last.Time)
	return found && last.Event == ev.Event && d >= 0 && d < sameHook
}

// siteSet reports whether this machine has a site to send to: one remembered
// by `helios login` or `sync -server`, or one named, with its key, by
// HELIOS_SERVER and HELIOS_KEY, as on an SSH box or in a dev container.
func siteSet() bool {
	if os.Getenv("HELIOS_SERVER") != "" && os.Getenv("HELIOS_KEY") != "" {
		return true
	}
	_, err := os.Stat(filepath.Join(dataDir(), "server"))
	return err == nil
}

// usageTail is how much of the end of a transcript lastTurnUsage reads. A
// hook must be quick, and a long session's file runs to hundreds of megabytes.
const usageTail = 8 << 20

// lastTurnUsage returns the tokens and lines of the latest turn of a Claude
// Code transcript: everything after the last prompt a person typed, and when
// that prompt was sent, which names the turn. Subagent records are not
// counted (see sources.ClaudeParser). It returns zeros when the file can't be
// read, or when what it read of it holds no prompt: then there is no telling
// where the turn began, and the whole file is not a turn.
func lastTurnUsage(path string) (at time.Time, in, out int64, added, removed int) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	var r io.Reader = f
	if info, err := f.Stat(); err == nil && info.Size() > usageTail {
		if _, err := f.Seek(-usageTail, io.SeekEnd); err != nil {
			return
		}
		// The read starts mid-line, so the first line goes unread.
		b, err := io.ReadAll(f)
		if err != nil {
			return
		}
		_, rest, _ := bytes.Cut(b, []byte("\n"))
		r = bytes.NewReader(rest)
	}
	raw, _ := sources.ClaudeParser()(r, "")
	start := -1
	for i, e := range raw.Events {
		if e.Kind == timeline.Human {
			start = i
		}
	}
	if start < 0 {
		return
	}
	at = raw.Events[start].Time
	for _, e := range raw.Events[start:] {
		in, out, added, removed = in+e.In, out+e.Out, added+e.Added, removed+e.Removed
	}
	return
}

// cloudEnv reports whether this is a disposable machine set up with a site and
// a key in the environment: a Claude Code cloud environment, a Codespace, or
// anything with HELIOS_CLOUD=1. Its hooks send events straight to the site,
// as the stable "cloud" computer, rather than journaling on a machine that
// will be gone, and no sign-in or per-container key is needed.
func cloudEnv() bool {
	return os.Getenv("HELIOS_SERVER") != "" && os.Getenv("HELIOS_KEY") != "" && cloudFlag() != ""
}

// cloudFlag names the environment variable that marks this machine as a
// disposable one, or is "" on a machine that has none.
func cloudFlag() string {
	for _, v := range []string{"HELIOS_CLOUD", "CLAUDE_CODE_REMOTE", "CODESPACES"} {
		if s := strings.ToLower(os.Getenv(v)); s == "1" || s == "true" {
			return v
		}
	}
	return ""
}

// dataDir is where helios keeps its own records, such as the hook journal.
func dataDir() string {
	if d := os.Getenv("HELIOS_DATA_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "helios")
		}
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "helios")
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "helios")
	}
	return filepath.Join(home, ".local", "share", "helios")
}

// hookCommand is the command Claude Code runs: this binary's absolute path.
// Forward slashes work in the Git Bash that Claude Code uses on Windows.
func hookCommand() (string, error) {
	exe, err := heliosPath()
	if err != nil {
		return "", err
	}
	return `"` + filepath.ToSlash(exe) + `" ` + hookArgs, nil
}

// isOurs reports whether a hook entry runs helios's hook command.
func isOurs(h map[string]json.RawMessage, tool string) bool {
	var c string
	json.Unmarshal(h["command"], &c)
	return ourCommand(c, tool)
}

// setHooks updates the "hooks" setting so it holds helios's hooks with
// command when install is true, or none when it is false, keeping every other
// hook as it was. It reports whether the setting changed.
func setHooks(settings map[string]json.RawMessage, command string, install bool) (bool, error) {
	return setHooksFor(settings, command, "claude-code", hookEvents, install)
}

// setHooksFor does what setHooks does, for a harness whose hooks file has
// Claude Code's shape, such as Codex's hooks.json.
func setHooksFor(settings map[string]json.RawMessage, command, tool string, events []string, install bool) (bool, error) {
	add := map[string]map[string]any{}
	if install {
		for _, e := range events {
			add[e] = map[string]any{"type": "command", "command": command, "timeout": 10}
		}
	}
	return setHookEntries(settings, tool, add)
}

// setHookEntries takes tool's helios hooks out of the "hooks" setting and
// puts in add's, one hook per event, keeping every other hook as it was. It
// reports whether the setting changed.
func setHookEntries(settings map[string]json.RawMessage, tool string, add map[string]map[string]any) (bool, error) {
	hooks := map[string][]map[string]json.RawMessage{}
	raw, had := settings["hooks"]
	if had && string(raw) != "null" {
		if err := json.Unmarshal(raw, &hooks); err != nil {
			return false, errors.New(txtUnknownHooksSetting)
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
	for e, h := range add {
		ours, _ := json.Marshal([]map[string]any{h})
		hooks[e] = append(hooks[e], map[string]json.RawMessage{"hooks": ours})
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

// checkHooks installs, updates, or removes helios's hooks in one Claude Code config dir.
func checkHooks(dir string, yes, remove bool) {
	path := filepath.Join(dir, "settings.json")
	settings, err := readSettings(path)
	if err != nil {
		fmt.Printf(txtClaudeUnreadable, path, err)
		return
	}
	hadOurs, _ := setHooks(maps.Clone(settings), "", false)
	command := ""
	if !remove {
		if command, err = hookCommand(); err != nil {
			fmt.Printf(txtClaudeSkipped, err)
			return
		}
	}
	changed, err := setHooks(settings, command, !remove)
	if err != nil {
		fmt.Printf(txtClaudeSetupFailed, path, err)
		return
	}
	switch {
	case !changed && !remove:
		fmt.Printf(txtClaudeInstalled, path)
		return
	case !changed:
		return
	case !remove && !hadOurs:
		fmt.Printf(txtClaudeAsk, dataDir())
		if !yes && !confirm(fmt.Sprintf(txtEditsConfirm, path)) {
			fmt.Print(txtSkippedRerun)
			return
		}
	}
	if err := writeSettings(path, settings); err != nil {
		fmt.Printf(txtCouldNotUpdate, path, err)
		return
	}
	switch {
	case remove:
		fmt.Printf(txtRemovedHooksFromNL, path)
	case hadOurs:
		fmt.Printf(txtUpdatedHookPath, path)
	default:
		fmt.Print(txtClaudeAdded)
	}
}
