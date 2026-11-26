package main

import (
	"bytes"
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
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// releasesURL is where the release workflow publishes helios's binaries,
// the same ones install.sh and install.ps1 download.
const releasesURL = "https://github.com/part-avocado/helios/releases"

// maxBinaryBytes is far more than a helios binary takes.
const maxBinaryBytes = 200 << 20

var releaseVersion = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)$`)

// runUpdate replaces this helios with the latest release, or the one
// named, then runs the new one's setup, as the installer does, so hooks and
// the Amp plugin match it.
func runUpdate(args []string) {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	checkOnly := fs.Bool("check", false, txtFlagCheck)
	auto := fs.String("auto", "", txtFlagAuto)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, txtUpdateUsage)
		fs.PrintDefaults()
	}
	picked := parseAnywhere(fs, args)
	if len(picked) > 1 || (len(picked) == 1 && *checkOnly) {
		fs.Usage()
		os.Exit(2)
	}
	if *auto != "" {
		if len(picked) > 0 || *checkOnly {
			fs.Usage()
			os.Exit(2)
		}
		check(setAutoUpdate(*auto))
		if autoUpdateOn() {
			fmt.Print(txtAutoOn)
		} else {
			fmt.Print(txtAutoOff)
		}
		return
	}
	pick := strings.Join(picked, "")
	exe, err := heliosPath()
	if err != nil && !*checkOnly {
		check(fmt.Errorf(txtUpdateNoPath, err))
	}
	msg, installed, err := update(&http.Client{Timeout: 5 * time.Minute}, releasesURL, exe, version, pick, *checkOnly)
	check(err)
	if installed {
		keepError("update", nil)
	}
	fmt.Println(msg)
	if !installed {
		return
	}
	fmt.Println()
	setup := exec.Command(exe, "setup")
	setup.Stdin, setup.Stdout, setup.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := setup.Run(); err != nil {
		fmt.Fprint(os.Stderr, txtUpdateSetupErr)
	}
}

// update installs a release from releases over the helios at exe: the
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
			return fmt.Sprintf(txtUpdateIsLatest, current), false, nil
		}
		if checkOnly {
			return fmt.Sprintf(txtUpdateIsOut, latest, current), false, nil
		}
	} else if !releaseVersion.MatchString(latest) {
		return "", false, fmt.Errorf(txtUpdateBadPick, pick)
	} else if latest == current {
		return fmt.Sprintf(txtUpdateHavePick, current), false, nil
	}
	binary, err := downloadRelease(client, releases+"/download/"+latest, assetName())
	if errors.Is(err, errNoRelease) {
		return "", false, fmt.Errorf(txtUpdateNoRelease, latest, releases)
	}
	if err != nil {
		return "", false, err
	}
	os.Remove(filepath.Join(dataDir(), "update-installed"))
	if err := replaceExecutable(exe, binary); err != nil {
		return "", false, fmt.Errorf(txtUpdateNoReplace, exe, err)
	}
	if pick != "" {
		return fmt.Sprintf(txtUpdateInstalled, latest, current, exe), true, nil
	}
	return fmt.Sprintf(txtUpdateUpdated, current, latest, exe), true, nil
}

// assetName is this platform's helios in a release.
func assetName() string {
	asset := fmt.Sprintf("helios_%s_%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	return asset
}

// errNoRelease means the release asked for has no downloads.
var errNoRelease = errors.New(txtNoSuchRelease)

// latestVersion asks where releases' "latest" link leads, which ends in the
// newest release's tag. That costs one request and no GitHub API allowance.
func latestVersion(client *http.Client, releases string) (string, error) {
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := c.Get(releases + "/latest")
	if err != nil {
		return "", fmt.Errorf(txtLatestFailed, err)
	}
	res.Body.Close()
	loc, err := res.Location()
	if err != nil {
		return "", fmt.Errorf(txtLatestAnswered, releases, res.Status)
	}
	tag := path.Base(loc.Path)
	if !releaseVersion.MatchString(tag) {
		return "", fmt.Errorf(txtLatestNone, releases)
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
		return nil, fmt.Errorf(txtSumsFailed, base, status)
	}
	want := ""
	for _, line := range strings.Split(string(sums), "\n") {
		// "<sha256>  <file>", with a * before the file when sha256sum ran in binary mode.
		if f := strings.Fields(line); len(f) == 2 && strings.TrimPrefix(f[1], "*") == asset {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return nil, fmt.Errorf(txtNoAsset, runtime.GOOS, runtime.GOARCH)
	}
	binary, status, err := fetch(client, base+"/"+asset, txtBarDownloading, maxBinaryBytes)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf(txtAssetFailed, base, asset, status)
	}
	if got := sha256.Sum256(binary); hex.EncodeToString(got[:]) != want {
		return nil, errors.New(txtChecksumBad)
	}
	return binary, nil
}

// fetch downloads url, up to limit bytes, with a progress bar when label is set.
func fetch(client *http.Client, url, label string, limit int64) ([]byte, int, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "helios/"+version)
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf(txtDownloadFailed, url, err)
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
		return nil, 0, fmt.Errorf(txtDownloadFailed, url, err)
	}
	if int64(len(b)) > limit {
		return nil, 0, fmt.Errorf(txtDownloadTooBig, url)
	}
	return b, res.StatusCode, nil
}

// replaceExecutable swaps the file at target for binary. The new file is
// written beside it and renamed into place, so target is never half-written
// and a helios that is running, such as a hook, keeps its old file.
func replaceExecutable(target string, binary []byte) error {
	old := target + ".old"
	os.Remove(old) // left by an earlier update on Windows
	f, err := os.CreateTemp(filepath.Dir(target), "helios-*.new")
	if err != nil {
		return err
	}
	next := f.Name()
	_, err = f.Write(binary)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(next)
		return err
	}
	// CreateTemp makes the file 0600.
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

// checkForUpdate looks up the latest release at most once a day and keeps
// the answer in the data folder, for updateNotice. Background syncs call it,
// so it never slows a command a person runs. With auto-update on, it also
// installs that release over the helios at exe; a failure is kept for
// `helios doctor`, and the notice stays.
func checkForUpdate(client *http.Client, releases, exe string) {
	notice := filepath.Join(dataDir(), "update-available")
	if !releaseVersion.MatchString(version) || !due(filepath.Join(dataDir(), "update-checked"), 24*time.Hour) {
		return
	}
	latest, err := latestVersion(client, releases)
	switch {
	case err != nil:
	case newer(latest, version):
		os.WriteFile(notice, []byte(latest+"\n"), 0o600)
		if !autoUpdateOn() {
			keepError("update", nil) // a failure from when it was on no longer stands
		} else if exe != "" {
			if err := autoUpdate(client, releases, exe, latest); err != nil {
				keepError("update", fmt.Errorf(txtAutoUpdateErr, latest, err))
			} else {
				keepError("update", nil)
				os.Remove(notice)
			}
		}
	default:
		keepError("update", nil) // this is the latest, so nothing is left to fail
		os.Remove(notice)
	}
}

// autoUpdateFile, in the data folder, turns auto-update on by being there.
const autoUpdateFile = "auto-update"

func autoUpdateOn() bool {
	_, err := os.Stat(filepath.Join(dataDir(), autoUpdateFile))
	return err == nil
}

// setAutoUpdate turns auto-update on or off.
func setAutoUpdate(to string) error {
	path := filepath.Join(dataDir(), autoUpdateFile)
	switch to {
	case "on":
		os.MkdirAll(dataDir(), 0o700)
		return os.WriteFile(path, nil, 0o600)
	case "off":
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return fmt.Errorf(txtAutoBad, to)
}

// autoUpdate installs release latest over exe, unattended. The download
// must match the release's checksums, and must run and say it is latest
// before it replaces anything. The helios it replaces is kept as
// exe.old, to go back to by hand.
func autoUpdate(client *http.Client, releases, exe, latest string) error {
	binary, err := downloadRelease(client, releases+"/download/"+latest, assetName())
	if err != nil {
		return err
	}
	// A name of its own, so two updates at once can't run or delete each other's.
	f, err := os.CreateTemp(filepath.Dir(exe), "helios-*.try"+filepath.Ext(exe))
	if err != nil {
		return err
	}
	try := f.Name()
	defer os.Remove(try)
	_, err = f.Write(binary)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	os.Chmod(try, 0o755)
	cmd := exec.Command(try, "-version")
	done := make(chan struct{})
	var out []byte
	go func() { out, err = cmd.Output(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		cmd.Process.Kill()
		<-done
		err = errors.New(txtTryTimedOut)
	}
	if err != nil || !strings.Contains(string(out), latest) {
		return fmt.Errorf(txtTryFailed, latest, err, strings.TrimSpace(string(out)))
	}
	previous, err := os.ReadFile(exe)
	if err != nil {
		return err
	}
	// Another update installed it meanwhile; its .old is the one to keep.
	if bytes.Equal(previous, binary) {
		return nil
	}
	if err := replaceExecutable(exe, binary); err != nil {
		return err
	}
	// Windows keeps the running one as .old already, until it can be deleted.
	if runtime.GOOS != "windows" {
		os.WriteFile(exe+".old", previous, 0o755)
	}
	os.WriteFile(filepath.Join(dataDir(), "update-installed"), []byte(version+" "+latest+"\n"), 0o600)
	return nil
}

// updateNotice is one line saying a newer release is out, or "" when this
// helios is that release or newer, such as right after `helios update`.
// For three days after auto-update installed one, it says so instead.
func updateNotice() string {
	if b, err := os.ReadFile(filepath.Join(dataDir(), "update-installed")); err == nil {
		info, _ := os.Stat(filepath.Join(dataDir(), "update-installed"))
		if f := strings.Fields(string(b)); len(f) == 2 && time.Since(info.ModTime()) < 72*time.Hour {
			return fmt.Sprintf(txtSelfUpdated, f[0], f[1])
		}
	}
	b, _ := os.ReadFile(filepath.Join(dataDir(), "update-available"))
	latest := strings.TrimSpace(string(b))
	if !releaseVersion.MatchString(version) || !newer(latest, version) {
		return ""
	}
	return fmt.Sprintf(txtUpdateNotice, latest, version)
}
