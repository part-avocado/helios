package main

import (
	"os"
	"path/filepath"
	"runtime"
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
		// A line for another install folder is not this teardrop's.
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
	// or by a symlink to where teardrop runs from. Both are this teardrop's.
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
	fish := filepath.Join(t.TempDir(), "teardrop.fish")
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

// Git Bash's install.sh writes the folder its own way, /c/Users/ada/bin.
func TestSameDirGitBash(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Git Bash paths are Windows paths")
	}
	if !sameDir("/c/Users/ada/bin", `C:\Users\ada\bin`) || sameDir("/c/Users/ada/bin2", `C:\Users\ada\bin`) {
		t.Error("a Git Bash line for the folder doesn't match, or another folder's does")
	}
	home, _ := os.UserHomeDir()
	if p := shellProfiles(); len(p) == 0 || p[0] != filepath.Join(home, ".bashrc") {
		t.Errorf("profiles on Windows: %v, want Git Bash's ~/.bashrc", p)
	}
}
