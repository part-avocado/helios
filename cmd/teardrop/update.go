package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// releasesURL is where the release workflow publishes teardrop's binaries,
// the same ones install.sh and install.ps1 download.
const releasesURL = "https://github.com/part-avocado/teardrop/releases"

// maxBinaryBytes is far more than a teardrop binary takes.
const maxBinaryBytes = 200 << 20

var releaseVersion = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)$`)

// runUpdate replaces this teardrop with the latest release, or the one
// named, then runs the new one's setup, as the installer does, so hooks and
// the Amp plugin match it.
func runUpdate(args []string) {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	checkOnly := fs.Bool("check", false, "only say whether a newer version is out")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: teardrop update [-check] [version]")
		fmt.Fprintln(os.Stderr, "       Downloads the latest teardrop, checks it, replaces this one with it,")
		fmt.Fprintln(os.Stderr, "       and runs `teardrop setup` with the new version. Name a version, such")
		fmt.Fprintln(os.Stderr, "       as v0.5.0, to install that one instead, even if it is older.")
		fmt.Fprintln(os.Stderr)
		fs.PrintDefaults()
	}
	picked := parseAnywhere(fs, args)
	if len(picked) > 1 || (len(picked) == 1 && *checkOnly) {
		fs.Usage()
		os.Exit(2)
	}
	pick := strings.Join(picked, "")
	exe, err := teardropPath()
	if err != nil && !*checkOnly {
		check(fmt.Errorf("%v, and then `teardrop update` keeps it current", err))
	}
	msg, installed, err := update(&http.Client{Timeout: 5 * time.Minute}, releasesURL, exe, version, pick, *checkOnly)
	check(err)
	fmt.Println(msg)
	if !installed {
		return
	}
	fmt.Println()
	setup := exec.Command(exe, "setup")
	setup.Stdin, setup.Stdout, setup.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := setup.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "teardrop is updated, but its setup did not finish. Run `teardrop setup` to try again.")
	}
}

// update installs a release from releases over the teardrop at exe: the
// version named by pick, even an older one, or with no pick the latest,
// unless current is at least that or checkOnly is set. It returns what to
// tell the person, and whether it installed anything.
func update(client *http.Client, releases, exe, current, pick string, checkOnly bool) (string, bool, error) {
	latest := "v" + strings.TrimPrefix(pick, "v")
	if pick == "" {
		var err error
		if latest, err = latestVersion(client, releases); err != nil {
			return "", false, err
		}
		if !newer(latest, current) {
			return fmt.Sprintf("teardrop %s is the latest version.", current), false, nil
		}
		if checkOnly {
			return fmt.Sprintf("teardrop %s is out; you have %s. Run `teardrop update` to install it.", latest, current), false, nil
		}
	} else if !releaseVersion.MatchString(latest) {
		return "", false, fmt.Errorf("%q is not a version; name one such as v0.5.0", pick)
	} else if latest == current {
		return fmt.Sprintf("teardrop %s is already installed.", current), false, nil
	}
	asset := fmt.Sprintf("teardrop_%s_%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	binary, err := downloadRelease(client, releases+"/download/"+latest, asset)
	if errors.Is(err, errNoRelease) {
		return "", false, fmt.Errorf("there is no teardrop release %s. They are listed at %s", latest, releases)
	}
	if err != nil {
		return "", false, err
	}
	if err := replaceExecutable(exe, binary); err != nil {
		return "", false, fmt.Errorf("could not replace %s: %w. If teardrop was installed with admin rights, update it the same way", exe, err)
	}
	if pick != "" {
		return fmt.Sprintf("Installed teardrop %s in place of %s (%s).", latest, current, exe), true, nil
	}
	return fmt.Sprintf("Updated teardrop from %s to %s (%s).", current, latest, exe), true, nil
}

// errNoRelease means the release asked for has no downloads.
var errNoRelease = errors.New("no such release")

// latestVersion asks where releases' "latest" link leads, which ends in the
// newest release's tag. That costs one request and no GitHub API allowance.
func latestVersion(client *http.Client, releases string) (string, error) {
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := c.Get(releases + "/latest")
	if err != nil {
		return "", fmt.Errorf("could not look up the latest version: %w", err)
	}
	res.Body.Close()
	loc, err := res.Location()
	if err != nil {
		return "", fmt.Errorf("could not look up the latest version: %s answered %s", releases, res.Status)
	}
	tag := path.Base(loc.Path)
	if !releaseVersion.MatchString(tag) {
		return "", fmt.Errorf("could not look up the latest version: %s has no release yet", releases)
	}
	return tag, nil
}

// newer reports whether release latest should replace current. A build
// that isn't a release, such as one from `go install`, is always replaced.
func newer(latest, current string) bool {
	l, c := releaseVersion.FindStringSubmatch(latest), releaseVersion.FindStringSubmatch(current)
	if l == nil {
		return false
	}
	if c == nil {
		return true
	}
	for i := 1; i <= 3; i++ {
		a, _ := strconv.Atoi(l[i])
		b, _ := strconv.Atoi(c[i])
		if a != b {
			return a > b
		}
	}
	return false
}

// downloadRelease fetches asset from a release's folder and checks it
// against the release's checksums.txt. It returns nothing it couldn't check.
func downloadRelease(client *http.Client, base, asset string) ([]byte, error) {
	sums, status, err := fetch(client, base+"/checksums.txt", "", 1<<20)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, errNoRelease
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("could not download %s/checksums.txt: the server answered %d", base, status)
	}
	want := ""
	for _, line := range strings.Split(string(sums), "\n") {
		// "<sha256>  <file>", with a * before the file when sha256sum ran in binary mode.
		if f := strings.Fields(line); len(f) == 2 && strings.TrimPrefix(f[1], "*") == asset {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return nil, fmt.Errorf("this release has no teardrop for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	binary, status, err := fetch(client, base+"/"+asset, "Downloading", maxBinaryBytes)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("could not download %s/%s: the server answered %d", base, asset, status)
	}
	if got := sha256.Sum256(binary); hex.EncodeToString(got[:]) != want {
		return nil, errors.New("the download is corrupted (checksum mismatch). Nothing was changed; try again")
	}
	return binary, nil
}

// fetch downloads url, up to limit bytes, with a progress bar when label is set.
func fetch(client *http.Client, url, label string, limit int64) ([]byte, int, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "teardrop/"+version)
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("could not download %s: %w", url, err)
	}
	defer res.Body.Close()
	total := res.ContentLength
	if label == "" {
		total = 0 // no bar
	}
	bar := newBar(label, total, "bytes")
	defer bar.done()
	b, err := io.ReadAll(&progressReader{r: io.LimitReader(res.Body, limit+1), b: bar})
	if err != nil {
		return nil, 0, fmt.Errorf("could not download %s: %w", url, err)
	}
	if int64(len(b)) > limit {
		return nil, 0, fmt.Errorf("could not download %s: it is larger than expected", url)
	}
	return b, res.StatusCode, nil
}

// replaceExecutable swaps the file at target for binary. The new file is
// written beside it and renamed into place, so target is never half-written
// and a teardrop that is running, such as a hook, keeps its old file.
func replaceExecutable(target string, binary []byte) error {
	next, old := target+".new", target+".old"
	os.Remove(old) // left by an earlier update on Windows
	if err := os.WriteFile(next, binary, 0o755); err != nil {
		os.Remove(next)
		return err
	}
	// WriteFile keeps the mode of a file that was already there.
	if err := os.Chmod(next, 0o755); err != nil {
		os.Remove(next)
		return err
	}
	if runtime.GOOS != "windows" {
		if err := os.Rename(next, target); err != nil {
			os.Remove(next)
			return err
		}
		return nil
	}
	// Windows can't replace a running .exe but can rename it, so the old one
	// moves aside. It can't be deleted until it stops running.
	if err := os.Rename(target, old); err != nil {
		os.Remove(next)
		return err
	}
	if err := os.Rename(next, target); err != nil {
		os.Rename(old, target)
		os.Remove(next)
		return err
	}
	os.Remove(old)
	return nil
}
