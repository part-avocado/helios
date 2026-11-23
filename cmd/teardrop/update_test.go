package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// releases stands in for GitHub's releases pages: "latest" redirects to the
// newest tag, and each tag has a folder of downloads. Every tag's teardrop
// differs, and sums makes the checksums.txt that goes with one.
func releases(t *testing.T, asset string, sums func(binary string) string, tags ...string) (*httptest.Server, *int) {
	downloads := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/latest" {
			http.Redirect(w, r, "/tag/"+tags[0], http.StatusFound)
			return
		}
		for _, tag := range tags {
			switch r.URL.Path {
			case "/download/" + tag + "/" + asset:
				downloads++
				fmt.Fprint(w, "teardrop "+tag)
				return
			case "/download/" + tag + "/checksums.txt":
				downloads++
				fmt.Fprint(w, sums("teardrop "+tag))
				return
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, &downloads
}

func TestUpdate(t *testing.T) {
	asset := fmt.Sprintf("teardrop_%s_%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	sum := func(s string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(s))) }
	good := func(binary string) string { return sum(binary) + "  " + asset + "\n" }
	cases := []struct {
		name      string
		current   string
		pick      string
		checkOnly bool
		sums      func(binary string) string
		installs  string // the tag whose teardrop ends up installed
		fails     string
		downloads int
	}{
		// v0.10.0 is newer than v0.9.0, though it sorts before it as text.
		{name: "an older release is replaced", current: "v0.9.0", installs: "v0.10.0", downloads: 2,
			sums: func(b string) string { return sum("another file") + "  teardrop_plan9_mips\n" + good(b) }},
		{name: "a build that is not a release is replaced", current: "dev", installs: "v0.10.0", downloads: 2,
			sums: func(b string) string { return sum(b) + " *" + asset + "\n" }},
		{name: "the latest release is left alone", current: "v0.10.0"},
		{name: "a newer build is left alone", current: "v0.11.0"},
		{name: "-check only looks", current: "v0.9.0", checkOnly: true},
		// The right checksum under another file's name doesn't vouch for this one.
		{name: "a download that fails its checksum is refused", current: "v0.9.0", fails: "checksum", downloads: 2,
			sums: func(b string) string {
				return sum("something else") + "  " + asset + "\n" + sum(b) + "  other_" + asset + "\n"
			}},
		{name: "a release without this platform is refused", current: "v0.9.0", fails: "no teardrop for", downloads: 1,
			sums: func(b string) string { return sum(b) + "  " + asset + ".sig\n" }},
		{name: "a picked version is installed even if older", current: "v0.9.0", pick: "v0.8.0", installs: "v0.8.0", downloads: 2},
		{name: "a picked version may leave out the v", current: "v0.10.0", pick: "0.8.0", installs: "v0.8.0", downloads: 2},
		{name: "picking the installed version does nothing", current: "v0.8.0", pick: "v0.8.0"},
		{name: "picking a version that was never released fails", current: "v0.9.0", pick: "v0.7.0", fails: "no teardrop release v0.7.0"},
		{name: "a pick that is not a version is never asked for", current: "v0.9.0", pick: "../v0.8.0", fails: "not a version"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.sums == nil {
				c.sums = good
			}
			srv, downloads := releases(t, asset, c.sums, "v0.10.0", "v0.8.0")
			exe := filepath.Join(t.TempDir(), "teardrop")
			if err := os.WriteFile(exe, []byte("the old teardrop"), 0o600); err != nil {
				t.Fatal(err)
			}
			msg, installed, err := update(srv.Client(), srv.URL, exe, c.current, c.pick, c.checkOnly)
			if c.fails != "" {
				if err == nil || !strings.Contains(err.Error(), c.fails) {
					t.Errorf("error %v, want one about %q", err, c.fails)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if installed != (c.installs != "") || *downloads != c.downloads {
				t.Errorf("installed %v after %d downloads (%q), want %q after %d", installed, *downloads, msg, c.installs, c.downloads)
			}
			want := "the old teardrop"
			if c.installs != "" {
				want = "teardrop " + c.installs
			}
			if got, _ := os.ReadFile(exe); string(got) != want {
				t.Errorf("the file holds %q, want %q", got, want)
			}
			if st, err := os.Stat(exe); c.installs != "" && runtime.GOOS != "windows" && (err != nil || st.Mode().Perm()&0o111 == 0) {
				t.Errorf("the new file can't be run: %v, %v", st.Mode(), err)
			}
			if left, _ := filepath.Glob(exe + ".*"); len(left) > 0 {
				t.Errorf("left behind %v", left)
			}
		})
	}
}

func TestUpdateNotice(t *testing.T) {
	t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
	latest, asked := "v0.10.0", 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked++
		http.Redirect(w, r, "/tag/"+latest, http.StatusFound)
	}))
	defer srv.Close()
	defer func(v string) { version = v }(version)

	version = "v0.9.0"
	checkForUpdate(srv.Client(), srv.URL, "")
	// v0.10.0 is newer, though it sorts before v0.9.0 as text.
	if got := updateNotice(); !strings.Contains(got, "v0.10.0 is out") {
		t.Errorf("notice after a newer release came out: %q", got)
	}
	checkForUpdate(srv.Client(), srv.URL, "")
	if asked != 1 {
		t.Errorf("asked GitHub %d times in a day, want 1", asked)
	}
	// Right after `teardrop update`, this is the release the notice names.
	version = "v0.10.0"
	if got := updateNotice(); got != "" {
		t.Errorf("notice once updated: %q", got)
	}

	// A day later, nothing newer: the notice is cleared.
	stamp := filepath.Join(dataDir(), "update-checked")
	old := time.Now().Add(-25 * time.Hour)
	os.Chtimes(stamp, old, old)
	version = "v0.9.0"
	latest = "v0.9.0"
	checkForUpdate(srv.Client(), srv.URL, "")
	if asked != 2 || updateNotice() != "" {
		t.Errorf("asked %d times, notice %q; want 2 and none", asked, updateNotice())
	}

	// A build that isn't a release, such as `go build`, neither asks nor nags.
	version = "dev"
	os.Chtimes(stamp, old, old)
	checkForUpdate(srv.Client(), srv.URL, "")
	if asked != 2 {
		t.Error("a dev build asked for the latest release")
	}
}

// With auto-update on, the daily check installs a newer release, but only
// one that runs and says it is that release; the old one is kept as .old.
func TestAutoUpdate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in releases are shell scripts")
	}
	defer func(v string) { version = v }(version)
	version = "v0.9.0"
	for _, c := range []struct {
		name, script string
		on, installs bool
	}{
		{"off only notes it", "#!/bin/sh\necho teardrop v0.10.0\n", false, false},
		{"on installs one that runs", "#!/bin/sh\necho teardrop v0.10.0\n", true, true},
		{"on refuses one that fails to run", "#!/bin/sh\nexit 1\n", true, false},
		{"on refuses one that says another version", "#!/bin/sh\necho teardrop v0.9.0\n", true, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
			asset := assetName()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/latest":
					http.Redirect(w, r, "/tag/v0.10.0", http.StatusFound)
				case "/download/v0.10.0/" + asset:
					fmt.Fprint(w, c.script)
				case "/download/v0.10.0/checksums.txt":
					fmt.Fprintf(w, "%x  %s\n", sha256.Sum256([]byte(c.script)), asset)
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			exe := filepath.Join(t.TempDir(), "teardrop")
			os.WriteFile(exe, []byte("old teardrop"), 0o755)
			if c.on {
				if err := setAutoUpdate("on"); err != nil {
					t.Fatal(err)
				}
			}
			checkForUpdate(srv.Client(), srv.URL, exe)
			got, _ := os.ReadFile(exe)
			old, oldErr := os.ReadFile(exe + ".old")
			if c.installs {
				if string(got) != c.script || string(old) != "old teardrop" {
					t.Errorf("installed %q, kept %q; want the release and the old one", got, old)
				}
				if n := updateNotice(); !strings.Contains(n, "updated itself from v0.9.0 to v0.10.0") {
					t.Errorf("notice %q", n)
				}
				return
			}
			if string(got) != "old teardrop" || oldErr == nil {
				t.Errorf("replaced the teardrop with %q", got)
			}
			if n := updateNotice(); !strings.Contains(n, "v0.10.0 is out") {
				t.Errorf("notice %q, want the release still noted", n)
			}
			if e, ok := readLastError(); c.on != ok || (ok && !strings.Contains(e.Message, "did not run as v0.10.0")) {
				t.Errorf("kept error %+v, %v", e, ok)
			}
			entries, _ := os.ReadDir(filepath.Dir(exe))
			if len(entries) != 1 {
				t.Errorf("left files beside it: %v", entries)
			}
		})
	}
	if setAutoUpdate("maybe") == nil {
		t.Error("-auto maybe was taken")
	}
}

// A failed auto-update's error goes once it no longer stands: when this
// teardrop is already the latest, or auto-update is off. Doctor says to run
// `teardrop update` for it, not sync.
func TestUpdateErrorClears(t *testing.T) {
	defer func(v string) { version = v }(version)
	for _, c := range []struct {
		name, running string
	}{
		{"already the latest", "v0.10.0"},
		{"auto-update off", "v0.9.0"},
	} {
		t.Run(c.name, func(t *testing.T) {
			version = c.running
			t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
			keepError("update", errors.New("could not update to v0.10.0 by itself: download failed"))
			for _, f := range diagnose("", "", http.DefaultClient, "http://127.0.0.1:1") {
				if f.Name == "Last error" && !strings.Contains(f.Fix, "`teardrop update`") {
					t.Errorf("doctor's fix for an update error: %q", f.Fix)
				}
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/latest" {
					http.Redirect(w, r, "/tag/v0.10.0", http.StatusFound)
					return
				}
				http.NotFound(w, r)
			}))
			defer srv.Close()
			checkForUpdate(srv.Client(), srv.URL, filepath.Join(t.TempDir(), "teardrop"))
			if e, ok := readLastError(); ok {
				t.Errorf("the update error stayed: %+v", e)
			}
		})
	}
}

// An update that finds the release already installed, by another update
// meanwhile, keeps the .old of the one before.
func TestAutoUpdateAlreadyInstalled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in release is a shell script")
	}
	defer func(v string) { version = v }(version)
	version = "v0.9.0"
	t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
	script := "#!/bin/sh\necho teardrop v0.10.0\n"
	asset := assetName()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/download/v0.10.0/" + asset:
			fmt.Fprint(w, script)
		case "/download/v0.10.0/checksums.txt":
			fmt.Fprintf(w, "%x  %s\n", sha256.Sum256([]byte(script)), asset)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	exe := filepath.Join(t.TempDir(), "teardrop")
	os.WriteFile(exe, []byte(script), 0o755)
	os.WriteFile(exe+".old", []byte("v0.9.0 teardrop"), 0o755)
	if err := autoUpdate(srv.Client(), srv.URL, exe, "v0.10.0"); err != nil {
		t.Fatal(err)
	}
	if old, _ := os.ReadFile(exe + ".old"); string(old) != "v0.9.0 teardrop" {
		t.Errorf(".old is now %q", old)
	}
}
