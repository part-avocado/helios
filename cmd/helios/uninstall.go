package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// installerMark heads the lines install.sh appends to a shell profile.
const installerMark = "\n# Added by the helios installer\n"

// runUninstall undoes what the installer and setup did on this computer:
// hooks, the Amp plugin, the PATH entry, and, if asked, the data folder,
// then deletes this binary.
func runUninstall(args []string) {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	yes := fs.Bool("yes", false, txtFlagUninstallYes)
	keepData := fs.Bool("keep-data", false, txtFlagKeepData)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, txtUninstallUsage)
		fs.PrintDefaults()
	}
	fs.Parse(args)
	exe, exeErr := heliosPath()
	fmt.Print(txtUninstallIntro)
	if exeErr == nil {
		fmt.Printf(txtUninstallThenDelete, exe)
	}
	if n := waitingRecords(); n > 0 {
		fmt.Printf(txtUninstallWaiting, plural(n, txtNounRecord))
	}
	if !*yes && !confirm(txtUninstallConfirm) {
		fmt.Print(txtUninstallUnchanged)
		return
	}

	for _, loc := range locations("", "") {
		if loc.Tool == "Claude Code" && exists(loc.Dir) {
			checkHooks(loc.Dir, true, true)
		}
	}
	checkCodex(true, true)
	checkFileHooks(func(string) bool { return true }, true, true)
	changePlugin(true, true)
	checkOpenCodePlugin(true, true)
	checkAntigravity(true, true)

	if exeErr == nil {
		dir := filepath.Dir(exe)
		found := false
		for _, p := range shellProfiles() {
			removed, err := removeInstallerLines(p, dir)
			switch {
			case err != nil:
				found = true
				fmt.Printf(txtProfileEditFailed, p, err, strings.TrimSpace(installerMark))
			case removed:
				found = true
				fmt.Printf(txtProfileRemoved, p)
			}
		}
		// On Windows, removeWindowsPath below takes out install.ps1's Path entry, the usual install.
		if !found && runtime.GOOS != "windows" {
			fmt.Printf(txtProfileNotFound, dir)
		}
		if runtime.GOOS == "windows" {
			removeWindowsPath(dir)
		}
	}

	data := dataDir()
	if exists(data) {
		keep := *keepData
		if !keep && !*yes {
			fmt.Printf(txtKeepDataAsk, data)
			keep = confirm(txtKeepDataConfirm)
		}
		if keep {
			fmt.Printf(txtDataKept, data)
		} else if err := os.RemoveAll(data); err != nil {
			fmt.Printf(txtDataDeleteFailed, data, err)
		} else {
			fmt.Printf(txtDataDeleted, data)
		}
	}

	fmt.Println()
	if exeErr != nil {
		fmt.Printf(txtUninstallNoBinary, exeErr)
	} else if removeBinary(exe) {
		fmt.Print(txtUninstallDone)
	} else {
		fmt.Printf(txtUninstallWindows, exe)
	}
	fmt.Print(txtUninstallOutro)
}

// shellProfiles lists the files install.sh may have added a PATH line to.
func shellProfiles() []string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		drive, user := os.Getenv("SystemDrive"), os.Getenv("USERNAME")
		if drive == "" {
			drive = "C:"
		}
		if user == "" {
			user = filepath.Base(home)
		}
		var out []string
		for _, h := range windowsHomes(home, drive, user) {
			out = append(out, filepath.Join(h, ".bashrc"), filepath.Join(h, ".bash_profile"))
		}
		return out
	}
	zdot := os.Getenv("ZDOTDIR")
	if zdot == "" {
		zdot = home
	}
	config := os.Getenv("XDG_CONFIG_HOME")
	if config == "" {
		config = filepath.Join(home, ".config")
	}
	return []string{
		filepath.Join(zdot, ".zshrc"),
		filepath.Join(home, ".bashrc"),
		filepath.Join(home, ".bash_profile"),
		filepath.Join(home, ".profile"),
		filepath.Join(config, "fish", "conf.d", "helios.fish"),
	}
}

// removeInstallerLines cuts every block install.sh appended to path for dir,
// leaving the rest of the file as it was. The fish file is the installer's
// own, so it goes once nothing else is in it.
func removeInstallerLines(path, dir string) (bool, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	s, removed := string(b), false
	for from := 0; ; {
		i := strings.Index(s[from:], installerMark)
		if i < 0 {
			break
		}
		i += from
		end := i + len(installerMark)
		line := s[end:]
		if n := strings.IndexByte(line, '\n'); n >= 0 {
			line = line[:n+1]
		}
		written := installerDir(line)
		if runtime.GOOS == "windows" {
			written = unixToWindows(written, path)
		}
		if !sameDir(written, dir) {
			from = end // another install's line; leave it
			continue
		}
		s = s[:i] + s[end+len(line):]
		removed = true
		from = i
	}
	if !removed {
		return false, nil
	}
	if strings.TrimSpace(s) == "" && filepath.Base(path) == "helios.fish" {
		return true, os.Remove(path)
	}
	info, _ := os.Stat(path)
	return true, os.WriteFile(path, []byte(s), info.Mode().Perm())
}

// installerDir is the folder an installer line adds to PATH: install.sh
// writes export PATH="dir:$PATH", or fish_add_path "dir".
func installerDir(line string) string {
	_, rest, _ := strings.Cut(line, `"`)
	if d, _, ok := strings.Cut(rest, `:$PATH"`); ok {
		return d
	}
	d, _, _ := strings.Cut(rest, `"`)
	return d
}

// sameDir is whether written, as the installer wrote it, is dir, which
// heliosPath resolved: written may end in a slash or go through a symlink.
func sameDir(written, dir string) bool {
	if written == "" {
		return false
	}
	if filepath.Clean(written) == filepath.Clean(dir) {
		return true
	}
	a, err1 := filepath.EvalSymlinks(written)
	b, err2 := filepath.EvalSymlinks(dir)
	return err1 == nil && err2 == nil && a == b
}

// windowsHomes lists the homes install.sh may have run in on Windows: Git
// Bash's, which is the profile folder, and those of Cygwin and MSYS2, which
// install on the system drive and name the home after the account.
func windowsHomes(home, drive, user string) []string {
	return []string{home, drive + `\cygwin64\home\` + user, drive + `\cygwin\home\` + user, drive + `\msys64\home\` + user}
}

// unixToWindows turns a folder a Unix shell on Windows wrote into profile
// into the Windows folder it is: /c/Users/ada/bin, as Git Bash writes it, is
// C:\Users\ada\bin, and so is /cygdrive/c/Users/ada/bin, as Cygwin writes it,
// where /cygdrive/c alone is C:\; /home/ada/bin or /usr/local/bin, in a
// profile under a Cygwin or MSYS2 root such as C:\cygwin64\home\ada, is under
// that root. Anything else is left as it is.
func unixToWindows(written, profile string) string {
	// Cygwin's /cygdrive/c is Git Bash's /c/: one letter, then a slash or the end.
	if rest, ok := strings.CutPrefix(written, "/cygdrive/"); ok && rest != "" && (len(rest) == 1 || rest[1] == '/') {
		if c := rest[0] | 0x20; c >= 'a' && c <= 'z' {
			written = "/" + rest[:1] + "/" + strings.TrimPrefix(rest[1:], "/")
		}
	}
	if len(written) > 2 && written[0] == '/' && written[2] == '/' && written[1] != '/' {
		return strings.ToUpper(written[1:2]) + ":" + strings.ReplaceAll(written[2:], "/", `\`)
	}
	if i := strings.Index(strings.ToLower(profile), `\home\`); strings.HasPrefix(written, "/") && !strings.HasPrefix(written, "//") && i > 0 {
		return profile[:i] + strings.ReplaceAll(written, "/", `\`)
	}
	return written
}

// removeWindowsPath takes dir out of the user's Path, where install.ps1 put it.
func removeWindowsPath(dir string) {
	script := `$d = $env:HELIOS_UNINSTALL_DIR.TrimEnd('\')
$all = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ })
$keep = @($all | Where-Object { $_.TrimEnd('\') -ne $d })
if ($keep.Count -ne $all.Count) { [Environment]::SetEnvironmentVariable('Path', ($keep -join ';'), 'User'); 'removed' }`
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = append(os.Environ(), "HELIOS_UNINSTALL_DIR="+dir)
	out, err := cmd.Output()
	switch {
	case err != nil:
		fmt.Printf(txtWinPathFailed, err, dir)
	case strings.TrimSpace(string(out)) == "removed":
		fmt.Printf(txtWinPathRemoved, dir)
	}
}

// removeBinary deletes exe and what updates left beside it. Windows can't
// delete a running program, so there it reports false.
func removeBinary(exe string) bool {
	os.Remove(exe + ".old")
	if err := os.Remove(exe); err != nil {
		return false
	}
	if runtime.GOOS == "windows" && filepath.Base(filepath.Dir(exe)) == "helios" {
		os.Remove(filepath.Dir(exe)) // the installer's own folder, if now empty
	}
	return true
}
