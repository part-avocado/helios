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
const installerMark = "\n# Added by the teardrop installer\n"

// runUninstall undoes what the installer and setup did on this computer:
// hooks, the Amp plugin, the PATH entry, and, if asked, the data folder,
// then deletes this binary.
func runUninstall(args []string) {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	yes := fs.Bool("yes", false, "don't ask; also deletes the data folder unless -keep-data is set")
	keepData := fs.Bool("keep-data", false, "keep teardrop's data folder")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: teardrop uninstall [-yes] [-keep-data]")
		fmt.Fprintln(os.Stderr, "       Removes teardrop's hooks, Amp plugin, PATH entry, and this binary.")
		fmt.Fprintln(os.Stderr)
		fs.PrintDefaults()
	}
	fs.Parse(args)
	exe, exeErr := teardropPath()
	fmt.Println("This removes teardrop's hooks from Claude Code, Codex, Cursor, and Copilot,")
	fmt.Println("its Amp and OpenCode plugins, and the PATH line the installer added.")
	if exeErr == nil {
		fmt.Printf("Then it deletes %s.\n", exe)
	}
	if n := waitingRecords(); n > 0 {
		fmt.Printf("\n%s not sent to your site yet. To send them first, stop here and run\n", plural(n, "record"))
		fmt.Println("`teardrop relay -verbose` and `teardrop sync`.")
	}
	if !*yes && !confirm("Uninstall teardrop? [Y/n] ") {
		fmt.Println("Nothing was changed.")
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

	if exeErr == nil {
		dir := filepath.Dir(exe)
		found := false
		for _, p := range shellProfiles() {
			removed, err := removeInstallerLines(p, dir)
			switch {
			case err != nil:
				found = true
				fmt.Printf("\n  Could not edit %s: %v. Delete the lines under %q in it.\n", p, err, strings.TrimSpace(installerMark))
			case removed:
				found = true
				fmt.Printf("\n  Removed the installer's PATH line from %s\n", p)
			}
		}
		// On Windows, removeWindowsPath below takes out install.ps1's Path entry, the usual install.
		if !found && runtime.GOOS != "windows" {
			fmt.Printf("\n  Found no installer PATH line for %s in your shell's startup files. If you added one, delete it.\n", dir)
		}
		if runtime.GOOS == "windows" {
			removeWindowsPath(dir)
		}
	}

	data := dataDir()
	if exists(data) {
		keep := *keepData
		if !keep && !*yes {
			fmt.Printf("\nKeep teardrop's data folder, %s?\n", data)
			fmt.Println("It holds the hook journal and this computer's account key, which names it on your site.")
			keep = confirm("Keep it if you may install teardrop here again. [Y/n] ")
		}
		if keep {
			fmt.Printf("\n  Kept %s\n", data)
		} else if err := os.RemoveAll(data); err != nil {
			fmt.Printf("\n  Could not delete %s: %v\n", data, err)
		} else {
			fmt.Printf("\n  Deleted %s\n", data)
		}
	}

	fmt.Println()
	if exeErr != nil {
		fmt.Printf("Done. Delete the teardrop binary yourself (%v).\n", exeErr)
	} else if removeBinary(exe) {
		fmt.Println("Done. teardrop is uninstalled.")
	} else {
		fmt.Printf("Done. Delete %s once this window closes; Windows can't delete a program while it runs.\n", exe)
	}
	fmt.Println("Your account on the site keeps what it has; remove this computer under Settings,")
	fmt.Println("Computers. Claude Code's longer history setting and teardrop's settings backups")
	fmt.Println("(*.teardrop-backup) are left as they are.")
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
		filepath.Join(config, "fish", "conf.d", "teardrop.fish"),
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
	if strings.TrimSpace(s) == "" && filepath.Base(path) == "teardrop.fish" {
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
// teardropPath resolved: written may end in a slash or go through a symlink.
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
// C:\Users\ada\bin, and so is /cygdrive/c/Users/ada/bin, as Cygwin writes it;
// /home/ada/bin or /usr/local/bin, in a profile under a Cygwin or MSYS2 root
// such as C:\cygwin64\home\ada, is under that root. Anything else is left
// as it is.
func unixToWindows(written, profile string) string {
	written = strings.TrimPrefix(written, "/cygdrive")
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
	script := `$d = $env:TEARDROP_UNINSTALL_DIR.TrimEnd('\')
$all = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ })
$keep = @($all | Where-Object { $_.TrimEnd('\') -ne $d })
if ($keep.Count -ne $all.Count) { [Environment]::SetEnvironmentVariable('Path', ($keep -join ';'), 'User'); 'removed' }`
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = append(os.Environ(), "TEARDROP_UNINSTALL_DIR="+dir)
	out, err := cmd.Output()
	switch {
	case err != nil:
		fmt.Printf("\n  Could not edit your Path (%v). Remove %s from it in Settings > Edit environment variables for your account.\n", err, dir)
	case strings.TrimSpace(string(out)) == "removed":
		fmt.Printf("\n  Removed %s from your Path\n", dir)
	}
}

// removeBinary deletes exe and what updates left beside it. Windows can't
// delete a running program, so there it reports false.
func removeBinary(exe string) bool {
	os.Remove(exe + ".old")
	if err := os.Remove(exe); err != nil {
		return false
	}
	if runtime.GOOS == "windows" && filepath.Base(filepath.Dir(exe)) == "teardrop" {
		os.Remove(filepath.Dir(exe)) // the installer's own folder, if now empty
	}
	return true
}
