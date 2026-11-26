package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// `helios setup <tool> -project` writes hooks into a repository, to commit,
// so that sessions of it on a cloud machine record time: Claude Code on the
// web, Codex cloud tasks, OpenCode on a server, and Antigravity on a remote
// machine. Claude Code's are setupProject's (setup.go). The others follow the
// same rules: they do nothing unless HELIOS_KEY is set, install helios at
// a session's start if it is missing, and pass -project, so they record only
// on a cloud machine (cloudEnv). On a person's own computers that tool's own
// hooks, which `helios setup` adds, record the session.

// projectTools are the tools `setup -project` can write repository hooks for.
var projectTools = []string{"Claude Code", "Codex", "Antigravity", "OpenCode"}

// projectInstall installs helios where the installer puts it, unless it is on PATH already.
const projectInstall = `PATH="$PATH:$HOME/.local/bin"; command -v helios >/dev/null || curl -fsSL https://raw.githubusercontent.com/part-avocado/helios/main/install.sh | HELIOS_NO_SETUP=1 sh >/dev/null 2>&1`

// projectCommand is what a repository hook for tool runs on event: with
// install, it installs helios first. event is passed with -event when the
// harness's payload doesn't name it.
func projectCommand(tool, event string, install bool) string {
	run := `helios hook ` + tool + ` ` + projectFlag
	if event != "" {
		run += ` -event ` + event
	}
	if tool == "antigravity" {
		// Antigravity needs a JSON object from every hook: helios prints it, and so does this when helios doesn't run.
		inst := ""
		if install {
			inst = projectInstall + `; `
		}
		return `if [ -z "$HELIOS_KEY" ]; then echo '{}'; else ` + inst + `PATH="$PATH:$HOME/.local/bin"; ` + run + ` 2>/dev/null || echo '{}'; fi`
	}
	if install {
		return `[ -z "$HELIOS_KEY" ] || { ` + projectInstall + `; ` + run + ` 2>/dev/null; } || true`
	}
	return `[ -z "$HELIOS_KEY" ] || PATH="$PATH:$HOME/.local/bin" ` + run + ` 2>/dev/null || true`
}

// setupToolProject writes, or with remove takes out, tool's repository hooks
// in the git repository that holds dir.
func setupToolProject(dir, tool string, yes, remove bool) error {
	root := gitOut(dir, "rev-parse", "--show-toplevel")
	if root == "" {
		return errors.New(txtNotInRepo)
	}
	var rel string
	var next []byte
	var changed bool
	var err error
	switch tool {
	case "Codex":
		rel = ".codex/hooks.json"
		next, changed, err = codexProjectHooks(filepath.Join(root, rel), remove)
	case "Antigravity":
		rel = ".agents/hooks.json"
		var group map[string]any
		if !remove {
			group = map[string]any{}
			for _, ev := range antigravityEvents {
				group[ev] = []map[string]any{{"type": "command", "command": projectCommand("antigravity", ev, ev == "SessionStart"), "timeout": map[bool]int{true: 120, false: 10}[ev == "SessionStart"]}}
			}
		}
		old, _ := os.ReadFile(filepath.Join(root, rel))
		next, changed, err = setAntigravityHooks(old, group)
	case "OpenCode":
		rel = ".opencode/plugins/helios-project.ts"
		old, readErr := os.ReadFile(filepath.Join(root, rel))
		if remove {
			changed = readErr == nil
		} else {
			// OpenCode spawns the plugin's program without a shell, so a shell
			// runs helios, with the plugin's own `hook opencode -event ...`.
			script := `[ -z "$HELIOS_KEY" ] || { ` + projectInstall + `; exec helios "$@" ` + projectFlag + `; }`
			next = renderOpenCodePluginWith("sh", []string{"-c", script, "helios-project"})
			next = bytes.Replace(next, []byte("records OpenCode activity in helios's local time-tracking journal"), []byte("records this repository's OpenCode sessions on a cloud machine"), 1)
			next = bytes.Replace(next, []byte("Written by `helios setup`. Rerun it to update this file, and run\n// `helios setup -remove-hooks opencode` to remove it."), []byte("Written by `helios setup opencode -project`; `-remove-hooks` removes it.\n// It does nothing unless HELIOS_KEY is set, and only records on a cloud machine."), 1)
			changed = !bytes.Equal(old, next)
		}
	default:
		return errors.New(txtProjectOnlyFor)
	}
	if err != nil {
		return fmt.Errorf(txtCouldNotSetUp, rel, err)
	}
	path := filepath.Join(root, filepath.FromSlash(rel))
	if !changed {
		if !remove {
			fmt.Printf(txtProjectToolOK, tool, path)
		}
		return nil
	}
	if remove {
		if tool == "OpenCode" {
			err = os.Remove(path)
		} else {
			err = writeFileAtomic(path, next)
		}
		if err == nil {
			fmt.Printf(txtRemovedHooksFrom, path)
		}
		return err
	}
	if !yes && !confirm(fmt.Sprintf(txtProjectToolConfirm, tool, path)) {
		fmt.Print(txtSkipped)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// Committed, so readable by all and with no backup next to it.
	if err := writeFileAtomic(path, next); err != nil {
		return err
	}
	os.Chmod(path, 0o644)
	fmt.Printf(txtProjectToolAdded, path)
	return nil
}

// codexProjectHooks returns a repository's .codex/hooks.json with helios's
// project hooks, or without them, and whether that changed it.
func codexProjectHooks(path string, remove bool) ([]byte, bool, error) {
	settings, err := readSettings(path)
	if err != nil {
		return nil, false, err
	}
	add := map[string]map[string]any{}
	if !remove {
		for _, e := range hookEvents {
			add[e] = map[string]any{"type": "command", "command": projectCommand("codex", "", false), "timeout": 10}
		}
		add["SessionStart"] = map[string]any{"type": "command", "command": projectCommand("codex", "", true), "timeout": 120}
	}
	changed, err := setHookEntries(settings, "codex", add)
	if err != nil || !changed {
		return nil, changed, err
	}
	b, err := json.MarshalIndent(settings, "", "  ")
	return append(b, '\n'), true, err
}
