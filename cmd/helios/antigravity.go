package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/part-avocado/helios/internal/sources"
)

// Antigravity (the App, the CLI, and the IDE) runs hooks from
// ~/.gemini/config/hooks.json, and from .agents/hooks.json in a workspace.
// The file is keyed by group name, and helios owns the "helios" group:
//
//	{"helios": {"SessionStart": [{"type": "command", "command": "..."}], "PreInvocation": [...], "Stop": [...]}}
//
// Its payload names neither the event nor a cwd: each command passes the
// event with -event, and the folder is the first of workspacePaths. There is
// no prompt event. PreInvocation runs before every model call, and the first
// call of an execution (invocationNum 0) is the one a person's prompt starts.
// Every hook must print a JSON object, so helios prints {} (harness.Ack).

// antigravityEvents are the Antigravity hooks helios installs.
var antigravityEvents = []string{"SessionStart", "PreInvocation", "Stop"}

// antigravityGroup is the name of helios's group in a hooks.json.
const antigravityGroup = "helios"

// geminiDir is the folder Antigravity keeps its settings and data in.
func geminiDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".gemini")
}

// antigravityHooksPath is Antigravity's global hooks file.
func antigravityHooksPath() string { return filepath.Join(geminiDir(), "config", "hooks.json") }

// antigravityInstalled reports whether Antigravity has run on this machine.
func antigravityInstalled() bool {
	for _, d := range []string{"antigravity", "antigravity-cli", "antigravity-ide", "config"} {
		if exists(filepath.Join(geminiDir(), d)) {
			return true
		}
	}
	return false
}

// antigravityHookGroup is helios's group, each event running prefix with -event.
func antigravityHookGroup(prefix string) map[string]any {
	group := map[string]any{}
	for _, ev := range antigravityEvents {
		group[ev] = []map[string]any{{"type": "command", "command": prefix + " -event " + ev, "timeout": 10}}
	}
	return group
}

// setAntigravityHooks updates an Antigravity hooks.json so it holds group as
// helios's, or none when group is nil, keeping every other group. It
// returns the new file and whether it changed.
func setAntigravityHooks(file []byte, group map[string]any) ([]byte, bool, error) {
	install := group != nil
	doc := map[string]json.RawMessage{}
	if strings.TrimSpace(string(file)) != "" {
		if err := json.Unmarshal(file, &doc); err != nil || doc == nil {
			return nil, false, errors.New(txtUnknownShape)
		}
	} else if !install {
		return file, false, nil
	}
	delete(doc, antigravityGroup)
	if install {
		doc[antigravityGroup], _ = json.Marshal(group)
	}
	next, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, false, err
	}
	return append(next, '\n'), !sameJSON(file, next), nil
}

// checkAntigravity installs, updates, or removes helios's Antigravity hooks.
func checkAntigravity(yes, remove bool) {
	path := antigravityHooksPath()
	old, err := os.ReadFile(path)
	if err != nil && !remove && !antigravityInstalled() {
		return
	}
	var group map[string]any
	if !remove {
		exe, err := heliosPath()
		if err != nil {
			fmt.Printf(txtAntigravSkipped, err)
			return
		}
		group = antigravityHookGroup(`"` + filepath.ToSlash(exe) + `" hook antigravity`)
	}
	next, changed, err := setAntigravityHooks(old, group)
	switch {
	case err != nil:
		fmt.Printf(txtAntigravSetupFailed, path, err)
	case !changed && !remove:
		fmt.Printf(txtAntigravInstalled, path)
	case !changed:
	case remove || yes || confirm(fmt.Sprintf(txtAntigravConfirm, path)):
		os.MkdirAll(filepath.Dir(path), 0o700)
		if err := writeFileAtomic(path, next); err != nil {
			fmt.Printf(txtCouldNotUpdate, path, err)
		} else if remove {
			fmt.Printf(txtRemovedHooksFromNL, path)
		} else {
			fmt.Print(txtAntigravAdded)
		}
	}
}

// antigravityStatus describes Antigravity for setup's table.
func antigravityStatus(journal []sources.Raw) string {
	sessions := 0
	var newest time.Time
	for _, j := range journal {
		if j.Tool != "antigravity" || len(j.Events) == 0 {
			continue
		}
		sessions++
		if last := j.Events[len(j.Events)-1].Time; last.After(newest) {
			newest = last
		}
	}
	b, _ := os.ReadFile(antigravityHooksPath())
	switch {
	case sessions > 0:
		return fmt.Sprintf(txtStatusOK, plural(sessions, txtNounSession), ago(newest))
	case strings.Contains(string(b), "hook antigravity"):
		return txtStatusHooksAdded
	case antigravityInstalled():
		return txtStatusHooksNotAdded
	}
	return txtStatusNotInstalled
}
