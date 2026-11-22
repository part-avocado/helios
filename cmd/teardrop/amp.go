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

// ampCLI reports whether the Amp CLI is on this machine. It is what runs
// threads here and loads the plugin.
func ampCLI() bool {
	if _, err := exec.LookPath("amp"); err == nil {
		return true
	}
	home, _ := os.UserHomeDir()
	for _, name := range []string{"amp", "amp.exe"} { // where Amp's installer puts it
		if _, err := os.Stat(filepath.Join(home, ".amp", "bin", name)); err == nil {
			return true
		}
	}
	return false
}

// ampApp returns where the Amp Mac app is installed, or "". The app is a
// window onto Amp: its threads run in Amp's cloud unless the Mac is one of
// the person's runners, which takes the CLI.
func ampApp() string {
	home, _ := os.UserHomeDir()
	for _, dir := range []string{"/Applications", filepath.Join(home, "Applications")} {
		if app := filepath.Join(dir, "Amp.app"); exists(app) {
			return app
		}
	}
	return ""
}

// ampInstalled reports whether Amp can run threads on this machine.
func ampInstalled() bool { return ampCLI() || exists(ampDir()) }

// ampAppOnly explains, when the Amp app is here without the CLI, why its
// threads are not counted and how to change that.
func ampAppOnly() {
	app := ampApp()
	if app == "" || ampCLI() {
		return
	}
	fmt.Printf("\n  The Amp app is installed (%s), but no thread runs on this computer yet.\n", app)
	fmt.Println("  The app's threads run in Amp's cloud, which teardrop can't see from here.")
	fmt.Println("  To count them, add teardrop's cloud plugin to Amp: your teardrop site has")
	fmt.Println("  the steps under Settings, Setup, Amp. That time is counted in the cloud")
	fmt.Println("  and shows up on your dashboard without this computer.")
	fmt.Println("  Or run your threads on this Mac: in the app, open App Settings, Runner,")
	fmt.Println("  and turn it on. That installs the Amp CLI, which loads teardrop's plugin.")
	fmt.Println("  Then pick \"This Mac\" when you start a thread.")
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
	case ampApp() != "":
		return "app only, threads run in the cloud"
	}
	return "not installed here"
}

// checkAmpPlugin installs, updates, or removes teardrop's Amp plugin. It
// offers the plugin on a machine without Amp too, so that it is in place when
// Amp arrives. It reports whether the plugin is there afterwards.
func checkAmpPlugin(yes, remove bool) bool {
	changePlugin(yes, remove)
	_, err := os.Stat(ampPluginPath())
	return err == nil
}

func changePlugin(yes, remove bool) {
	path := ampPluginPath()
	found := ampInstalled()
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
		if !found && ampApp() == "" {
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
		return "", errors.New("teardrop is running from `go run`; install it first")
	}
	return exe, nil
}
