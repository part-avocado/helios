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

	"github.com/part-avocado/helios/internal/sources"
)

// OpenCode 2 runs plugins in its server. Its history is in SQLite, which
// helios doesn't read, so only time the plugin records counts.

//go:embed opencode-plugin.ts
var openCodePluginTemplate []byte

const openCodePluginMarker = "// helios: records OpenCode activity"

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
func openCodePluginPath() string { return filepath.Join(openCodeDir(), "plugins", "helios.ts") }

func renderOpenCodePlugin(exe string) []byte {
	return renderOpenCodePluginWith(exe, []string{})
}

// renderOpenCodePluginWith is the plugin that runs program with before ahead
// of helios's own arguments, such as a shell running cloud.sh.
func renderOpenCodePluginWith(program string, before []string) []byte {
	lit, _ := json.Marshal(program) // escapes Windows backslashes
	args, _ := json.Marshal(before)
	out := bytes.Replace(openCodePluginTemplate, []byte("__HELIOS_PATH__"), lit, 1)
	return bytes.Replace(out, []byte("__HELIOS_ARGS__"), args, 1)
}

// openCodeInstalled reports whether OpenCode is on this machine.
func openCodeInstalled() bool {
	_, err := exec.LookPath("opencode")
	return err == nil || exists(openCodeDir())
}

// checkOpenCodePlugin installs, updates, or removes helios's OpenCode
// plugin, on a machine with OpenCode. It reports whether the plugin is there
// afterwards.
func checkOpenCodePlugin(yes, remove bool) bool {
	path := openCodePluginPath()
	old, err := os.ReadFile(path)
	there := err == nil
	switch {
	case there && !bytes.HasPrefix(old, []byte(openCodePluginMarker)):
		fmt.Printf(txtNotOurs, path)
		return true
	case remove:
		if there {
			if err := os.Remove(path); err != nil {
				fmt.Printf(txtCouldNotRemove, path, err)
				return true
			}
			fmt.Printf(txtOpenCodeRemoved, path)
		}
		return false
	case !there && !openCodeInstalled():
		return false
	}
	exe, err := heliosPath()
	if err != nil {
		fmt.Printf(txtOpenCodeSkipped, err)
		return there
	}
	next := renderOpenCodePlugin(exe)
	if bytes.Equal(old, next) {
		fmt.Printf(txtOpenCodeInstalled, path)
		return true
	}
	if !there {
		fmt.Print(txtOpenCodeAsk)
		if !yes && !confirm(fmt.Sprintf(txtCreatesConfirm, path)) {
			fmt.Print(txtOpenCodeSkippedRerun)
			return false
		}
	}
	if err := writeFileAtomic(path, next); err != nil {
		fmt.Printf(txtCouldNotWrite, path, err)
		return there
	}
	if there {
		fmt.Printf(txtOpenCodeUpdated, path)
	} else {
		fmt.Print(txtOpenCodeAdded)
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
		return fmt.Sprintf(txtStatusOK, plural(sessions, txtNounSession), ago(newest))
	case err == nil:
		return txtStatusPluginAdded
	case openCodeInstalled():
		return txtStatusPluginNotAdded
	}
	return txtStatusNotInstalled
}
