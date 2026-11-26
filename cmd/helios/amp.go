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

	"github.com/part-avocado/helios/internal/sources"
)

//go:embed amp-plugin.ts
var ampPluginTemplate []byte

const ampPluginMarker = "// helios: records Amp activity"

// ampPluginPath is Amp's user-local plugin file for helios.
func ampPluginPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "amp", "plugins", "helios.ts")
}

// renderAmpPlugin fills in the path of the helios binary as a string literal.
func renderAmpPlugin(exe string) []byte {
	lit, _ := json.Marshal(exe) // escapes Windows backslashes
	return bytes.Replace(ampPluginTemplate, []byte("__HELIOS_PATH__"), lit, 1)
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
	fmt.Printf(txtAmpAppOnly, app)
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
		return fmt.Sprintf(txtStatusOK, plural(sessions, txtNounSession), ago(newest))
	case err == nil:
		return txtStatusPluginAdded
	case ampInstalled():
		return txtStatusPluginNotAdded
	case ampApp() != "":
		return txtStatusAmpAppOnly
	}
	return txtStatusNotInstalled
}

// checkAmpPlugin installs, updates, or removes helios's Amp plugin. It
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
		fmt.Printf(txtNotOurs, path)
		return
	}
	if remove {
		if exists {
			if err := os.Remove(path); err != nil {
				fmt.Printf(txtCouldNotRemove, path, err)
				return
			}
			fmt.Printf(txtAmpRemoved, path)
		}
		return
	}
	exe, err := heliosPath()
	if err != nil {
		fmt.Printf(txtAmpSkipped, err)
		return
	}
	next := renderAmpPlugin(exe)
	if bytes.Equal(old, next) {
		fmt.Printf(txtAmpInstalled, path)
		return
	}
	if !exists {
		if !found && ampApp() == "" {
			fmt.Print(txtAmpNotFound)
		}
		fmt.Print(txtAmpAsk)
		if !yes && !confirm(fmt.Sprintf(txtCreatesConfirm, path)) {
			fmt.Print(txtSkippedRerun)
			return
		}
	}
	if err := writeFileAtomic(path, next); err != nil {
		fmt.Printf(txtCouldNotWrite, path, err)
		return
	}
	if exists {
		fmt.Printf(txtAmpUpdated, path)
	} else {
		fmt.Print(txtAmpAdded)
	}
}

func writeFileAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".helios-tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// heliosPath is this binary's lasting absolute path.
func heliosPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	if strings.Contains(exe, "go-build") {
		return "", errors.New(txtGoRun)
	}
	return exe, nil
}
