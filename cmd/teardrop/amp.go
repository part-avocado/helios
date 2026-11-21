package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

//go:embed amp-plugin.ts
var ampPluginTemplate []byte

const ampPluginMarker = "// teardrop: records Amp activity"

// ampPluginPath is Amp's user-local plugin file for teardrop.
func ampPluginPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "amp", "plugins", "teardrop.ts")
}

// renderAmpPlugin fills in the path of the teardrop binary as a string literal.
func renderAmpPlugin(exe string) []byte {
	lit, _ := json.Marshal(exe) // escapes Windows backslashes
	return bytes.Replace(ampPluginTemplate, []byte("__TEARDROP_PATH__"), lit, 1)
}

// ampDir is Amp's config directory.
func ampDir() string { return filepath.Dir(filepath.Dir(ampPluginPath())) }

// ampInstalled reports whether Amp looks set up on this machine.
func ampInstalled() bool {
	_, err := exec.LookPath("amp")
	return err == nil || exists(ampDir())
}

// ampStatus describes Amp for setup's table. Amp keeps no local logs, so its
// sessions are the ones the plugin wrote to the journal.
func ampStatus(journal []sources.Raw) string {
	sessions := 0
	var newest time.Time
	for _, j := range journal {
		if j.Tool != "amp" || len(j.Events) == 0 {
			continue
		}
		sessions++
		if last := j.Events[len(j.Events)-1].Time; last.After(newest) {
			newest = last
		}
	}
	_, err := os.Stat(ampPluginPath())
	switch {
	case sessions > 0:
		return fmt.Sprintf("ok: %s, newest %s", plural(sessions, "session"), ago(newest))
	case err == nil:
		return "plugin added, no sessions yet"
	case ampInstalled():
		return "installed, plugin not added"
	}
	return "not installed here"
}

// checkAmpPlugin installs, updates, or removes teardrop's Amp plugin. Unless
// force is set, it does nothing on a machine without Amp.
func checkAmpPlugin(yes, remove, force bool) {
	path := ampPluginPath()
	found := ampInstalled()
	if !found && !force {
		return
	}
	old, err := os.ReadFile(path)
	exists := err == nil
	if exists && !bytes.HasPrefix(old, []byte(ampPluginMarker)) {
		fmt.Printf("\n  %s exists but was not written by teardrop, so it was left alone.\n", path)
		return
	}
	if remove {
		if exists {
			if err := os.Remove(path); err != nil {
				fmt.Printf("\n  Could not remove %s: %v\n", path, err)
				return
			}
			fmt.Printf("\n  Removed the teardrop Amp plugin (%s)\n", path)
		}
		return
	}
	exe, err := teardropPath()
	if err != nil {
		fmt.Printf("\n  Skipped the Amp plugin: %v.\n", err)
		return
	}
	next := renderAmpPlugin(exe)
	if bytes.Equal(old, next) {
		fmt.Printf("\n  Amp plugin: installed (%s)\n", path)
		return
	}
	if !exists {
		if !found {
			fmt.Println("\n  Amp was not found on this machine. The plugin can be added anyway, and")
			fmt.Println("  Amp loads it once installed.")
		}
		fmt.Println("\n  Add a teardrop plugin to Amp? When you send a prompt or Amp finishes, it")
		fmt.Println("  records the time and folder (never the prompt text) in teardrop's journal.")
		if !yes && !confirm("  This creates "+path+" [Y/n] ") {
			fmt.Println("  Skipped. Run `teardrop setup` again to change your mind.")
			return
		}
	}
	if err := writeFileAtomic(path, next); err != nil {
		fmt.Printf("  Could not write %s: %v\n", path, err)
		return
	}
	if exists {
		fmt.Printf("\n  Updated the teardrop Amp plugin (%s)\n", path)
	} else {
		fmt.Println("  Added. New Amp threads load it; in open ones, run `plugins: reload`.")
	}
}

func writeFileAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".teardrop-tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// teardropPath is this binary's lasting absolute path.
func teardropPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	if strings.Contains(exe, "go-build") {
		return "", errors.New("teardrop is running from `go run`; install it first so hooks point at a lasting path")
	}
	return exe, nil
}
