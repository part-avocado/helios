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

// checkAmpPlugin installs, updates, or removes teardrop's Amp plugin.
func checkAmpPlugin(yes, remove bool) {
	path := ampPluginPath()
	_, err := exec.LookPath("amp")
	if err != nil && !exists(filepath.Dir(filepath.Dir(path))) {
		return // Amp is not installed
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
