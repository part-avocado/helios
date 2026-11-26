package main

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

func TestRemoveInstallerLines(t *testing.T) {
	const dir = "/home/ada/.local/bin"
	ours := installerMark + `export PATH="` + dir + `:$PATH"` + "\n"
	other := installerMark + `export PATH="` + dir + `2:$PATH"` + "\n" // a folder whose name starts with dir
	for _, c := range []struct {
		name, file, before, after string
		removed                   bool
	}{
		{"between the person's lines", ".zshrc", "alias g=git\n" + ours + "export EDITOR=vim\n", "alias g=git\nexport EDITOR=vim\n", true},
		// install.sh appends after a file with no final newline too.
		{"no final newline before it", ".bashrc", "alias g=git" + ours, "alias g=git", true},
		{"installed twice", ".profile", "a\n" + ours + ours, "a\n", true},
		// A line for another install folder is not this helios's.
		{"another folder's line stays", ".zshrc", "a\n" + other + ours, "a\n" + other, true},
		{"nothing of ours", ".zshrc", "a\n" + other, "a\n" + other, false},
		{"the installer made the file", ".profile", ours, "", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), c.file)
			os.WriteFile(path, []byte(c.before), 0o640)
			removed, err := removeInstallerLines(path, dir)
			got, _ := os.ReadFile(path)
			if err != nil || removed != c.removed || string(got) != c.after {
				t.Errorf("removed %v, err %v, file now %q; want %v and %q", removed, err, got, c.removed, c.after)
			}
			if info, _ := os.Stat(path); runtime.GOOS != "windows" && info.Mode().Perm() != 0o640 {
				t.Errorf("mode changed to %v", info.Mode().Perm())
			}
		})
	}

	// The installer wrote the folder as it was given: with a trailing slash,
	// or by a symlink to where helios runs from. Both are this helios's.
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "bin")
	if err := os.Symlink(real, link); err == nil {
		for _, written := range []string{real + "/", link} {
			path := filepath.Join(t.TempDir(), ".zshrc")
			os.WriteFile(path, []byte("a\n"+installerMark+`export PATH="`+written+`:$PATH"`+"\n"), 0o644)
			if removed, err := removeInstallerLines(path, real); !removed || err != nil {
				got, _ := os.ReadFile(path)
				t.Errorf("a line for %q: removed %v, err %v, file now %q", written, removed, err, got)
			}
		}
	}

	// The fish file is the installer's own, so it goes once it is empty.
	fish := filepath.Join(t.TempDir(), "helios.fish")
	os.WriteFile(fish, []byte(installerMark+`fish_add_path "`+dir+`"`+"\n"), 0o644)
	if removed, err := removeInstallerLines(fish, dir); !removed || err != nil {
		t.Fatalf("fish: removed %v, err %v", removed, err)
	}
	if _, err := os.Stat(fish); !os.IsNotExist(err) {
		t.Error("the emptied fish file was left behind")
	}
	if removed, err := removeInstallerLines(fish, dir); removed || err != nil {
		t.Errorf("a missing file: removed %v, err %v", removed, err)
	}
}

// Git Bash, Cygwin and MSYS2 write the folder as their shell sees it:
// /c/Users/ada/bin, or /home/ada/bin under the install's own root.
func TestUnixToWindows(t *testing.T) {
	for _, c := range []struct{ written, profile, want string }{
		{"/c/Users/ada/bin", `C:\Users\ada\.bashrc`, `C:\Users\ada\bin`},
		{"/home/ada/.local/bin", `C:\cygwin64\home\ada\.bashrc`, `C:\cygwin64\home\ada\.local\bin`},
		{"/home/ada/.local/bin", `C:\msys64\home\ada\.bash_profile`, `C:\msys64\home\ada\.local\bin`},
		// Cygwin names drives under /cygdrive, and its other folders are under its root.
		{"/cygdrive/d/tools", `C:\cygwin64\home\ada\.bashrc`, `D:\tools`},
		{"/usr/local/bin", `C:\cygwin64\home\ada\.bashrc`, `C:\cygwin64\usr\local\bin`},
		// A drive is /cygdrive, a slash, and one letter; the drive alone is its root.
		{"/cygdrive/c", `C:\cygwin64\home\ada\.bashrc`, `C:\`},
		{"/cygdrive/c/", `C:\cygwin64\home\ada\.bashrc`, `C:\`},
		{"/cygdrive", `C:\cygwin64\home\ada\.bashrc`, `C:\cygwin64\cygdrive`},
		{"/cygdrivex/y/z", `C:\cygwin64\home\ada\.bashrc`, `C:\cygwin64\cygdrivex\y\z`},
		{"/cygdrive/cc/x", `C:\cygwin64\home\ada\.bashrc`, `C:\cygwin64\cygdrive\cc\x`},
		{"/cygdrive/1/x", `C:\cygwin64\home\ada\.bashrc`, `C:\cygwin64\cygdrive\1\x`},
		{"/cygdrivex/y/z", `C:\Users\ada\.bashrc`, "/cygdrivex/y/z"},
		// Git Bash's own /home is somewhere else, so such a line isn't read as a Windows folder.
		{"/home/ada/bin", `C:\Users\ada\.bashrc`, "/home/ada/bin"},
		{`C:\Users\ada\bin`, `C:\Users\ada\.bashrc`, `C:\Users\ada\bin`},
	} {
		if got := unixToWindows(c.written, c.profile); got != c.want {
			t.Errorf("unixToWindows(%q, %q) = %q, want %q", c.written, c.profile, got, c.want)
		}
	}
	// Cygwin and MSYS2 live on the system drive and name their homes after the
	// account, which needn't be the profile folder's name.
	homes := windowsHomes(`D:\Users\ada.CORP`, "D:", "ada")
	for _, want := range []string{`D:\Users\ada.CORP`, `D:\cygwin64\home\ada`, `D:\cygwin\home\ada`, `D:\msys64\home\ada`} {
		if !slices.Contains(homes, want) {
			t.Errorf("windowsHomes: %v, want %s", homes, want)
		}
	}
	if runtime.GOOS == "windows" {
		home, _ := os.UserHomeDir()
		for _, c := range []struct{ drive, user, cygwin string }{
			{"D:", "ada", `D:\cygwin64\home\ada`},
			// Without them, it is the usual drive and the profile folder's name.
			{"", "", `C:\cygwin64\home\` + filepath.Base(home)},
		} {
			t.Setenv("SystemDrive", c.drive)
			t.Setenv("USERNAME", c.user)
			git, cygwin := filepath.Join(home, ".bashrc"), filepath.Join(c.cygwin, ".bashrc")
			if p := shellProfiles(); !slices.Contains(p, git) || !slices.Contains(p, cygwin) {
				t.Errorf("profiles on Windows with SystemDrive %q and USERNAME %q: %v, want %s and %s", c.drive, c.user, p, git, cygwin)
			}
		}
	}
}
