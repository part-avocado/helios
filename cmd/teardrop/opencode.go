package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

// OpenCode 2 runs plugins in its server. Its history is in SQLite, which
// teardrop doesn't read, so only time the plugin records counts.

//go:embed opencode-plugin.ts
var openCodePluginTemplate []byte

const openCodePluginMarker = "// teardrop: records OpenCode activity"

// openCodeDir is OpenCode's global config folder.
func openCodeDir() string {
	if d := os.Getenv("OPENCODE_CONFIG_DIR"); d != "" {
		return d
	}
	config := os.Getenv("XDG_CONFIG_HOME")
	if config == "" {
		home, _ := os.UserHomeDir()
		config = filepath.Join(home, ".config") // on Windows too
	}
	return filepath.Join(config, "opencode")
}

// openCodePluginPath is where OpenCode finds global plugins.
func openCodePluginPath() string { return filepath.Join(openCodeDir(), "plugins", "teardrop.ts") }

func renderOpenCodePlugin(exe string) []byte {
	return renderOpenCodePluginWith(exe, []string{})
}

// renderOpenCodePluginWith is the plugin that runs program with before ahead
// of teardrop's own arguments, such as a shell running cloud.sh.
func renderOpenCodePluginWith(program string, before []string) []byte {
	lit, _ := json.Marshal(program) // escapes Windows backslashes
	args, _ := json.Marshal(before)
	out := bytes.Replace(openCodePluginTemplate, []byte("__TEARDROP_PATH__"), lit, 1)
	return bytes.Replace(out, []byte("__TEARDROP_ARGS__"), args, 1)
}

// openCodeInstalled reports whether OpenCode is on this machine.
func openCodeInstalled() bool {
	_, err := exec.LookPath("opencode")
	return err == nil || exists(openCodeDir())
}

// checkOpenCodePlugin installs, updates, or removes teardrop's OpenCode
// plugin, on a machine with OpenCode. It reports whether the plugin is there
// afterwards.
func checkOpenCodePlugin(yes, remove bool) bool {
	path := openCodePluginPath()
	old, err := os.ReadFile(path)
	there := err == nil
	switch {
	case there && !bytes.HasPrefix(old, []byte(openCodePluginMarker)):
		fmt.Printf("\n  %s exists but was not written by teardrop, so it was left alone.\n", path)
		return true
	case remove:
		if there {
			if err := os.Remove(path); err != nil {
				fmt.Printf("\n  Could not remove %s: %v\n", path, err)
				return true
			}
			fmt.Printf("\n  Removed the teardrop OpenCode plugin (%s)\n", path)
		}
		return false
	case !there && !openCodeInstalled():
		return false
	}
	exe, err := teardropPath()
	if err != nil {
		fmt.Printf("\n  Skipped the OpenCode plugin: %v.\n", err)
		return there
	}
	next := renderOpenCodePlugin(exe)
	if bytes.Equal(old, next) {
		fmt.Printf("\n  OpenCode plugin: installed (%s)\n", path)
		return true
	}
	if !there {
		fmt.Println("\n  Add a teardrop plugin to OpenCode? When you send a prompt or a turn ends, it")
		fmt.Println("  records the time and folder (never the prompt text) in teardrop's journal.")
		fmt.Println("  OpenCode's past sessions can't be read, so time counts from now on.")
		if !yes && !confirm("  This creates "+path+" [Y/n] ") {
			fmt.Println("  Skipped. Run `teardrop setup opencode` to change your mind.")
			return false
		}
	}
	if err := writeFileAtomic(path, next); err != nil {
		fmt.Printf("  Could not write %s: %v\n", path, err)
		return there
	}
	if there {
		fmt.Printf("\n  Updated the teardrop OpenCode plugin (%s)\n", path)
	} else {
		fmt.Println("  Added. OpenCode loads it on its own; restart OpenCode if it doesn't.")
	}
	return true
}

// openCodeStatus describes OpenCode for setup's table, from the sessions
// the plugin wrote to the journal.
func openCodeStatus(journal []sources.Raw) string {
	sessions := 0
	var newest time.Time
	for _, j := range journal {
		if j.Tool != "opencode" || len(j.Events) == 0 {
			continue
		}
		sessions++
		if last := j.Events[len(j.Events)-1].Time; last.After(newest) {
			newest = last
		}
	}
	_, err := os.Stat(openCodePluginPath())
	switch {
	case sessions > 0:
		return fmt.Sprintf("ok: %s, newest %s", plural(sessions, "session"), ago(newest))
	case err == nil:
		return "plugin added, no sessions yet"
	case openCodeInstalled():
		return "installed, plugin not added"
	}
	return "not installed here"
}
