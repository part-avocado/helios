package main

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
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
