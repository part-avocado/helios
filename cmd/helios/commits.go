package main

import (
	"bufio"
	"crypto/sha256"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/part-avocado/helios/internal/sources"
)

// commitLines holds the lines added by the person's commits in one repository.
type commitLines struct {
	added  int            // every added line, blank ones excluded
	hashes map[uint64]int // added lines not yet matched to an agent's edit
}

// readCommits reads the lines added by commits since t on any branch,
// authored by the repository's configured user.email when one is set. A
// directory that is not a git repository has no commits.
func readCommits(root string, since time.Time) *commitLines {
	c := &commitLines{hashes: map[uint64]int{}}
	if root == "" || !exists(root) {
		return c
	}
	args := []string{"-C", root, "log", "--all", "--no-merges", "--no-color", "--no-ext-diff", "--no-renames",
		"--since=" + strconv.FormatInt(since.Unix(), 10), "--format=", "-p", "--unified=0"}
	if email := gitOut(root, "config", "user.email"); email != "" {
		args = append(args, "--author=<"+email+">")
	}
	cmd := exec.Command("git", args...)
	out, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return c
	}
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 16<<20)
	for sc.Scan() {
		l := sc.Text()
		if !strings.HasPrefix(l, "+") || strings.HasPrefix(l, "+++") || strings.TrimSpace(l[1:]) == "" {
			continue
		}
		c.added++
		if h, ok := sources.LineHash(l[1:]); ok {
			c.hashes[h]++
		}
	}
	cmd.Wait()
	return c
}

func (c *commitLines) clone() *commitLines {
	return &commitLines{added: c.added, hashes: maps.Clone(c.hashes)}
}

// claim counts the hashes found among the committed lines, matching each
// committed line to one written line at most.
func (c *commitLines) claim(hashes []uint64) int {
	n := 0
	for _, h := range hashes {
		if c.hashes[h] > 0 {
			c.hashes[h]--
			n++
		}
	}
	return n
}

// commit is one commit of the person's, as it goes to the site: never its
// message or its code.
type commit struct {
	Sha     string
	Time    time.Time // the author's, which they set
	Added   int
	Removed int
}

// listCommits returns the person's commits in the repository at root since t,
// on any branch, with the lines each added and removed.
func listCommits(root string, since time.Time) []commit {
	if root == "" || !exists(root) {
		return nil
	}
	args := []string{"-C", root, "log", "--all", "--no-merges", "--no-color", "--no-renames",
		"--since=" + strconv.FormatInt(since.Unix(), 10), "--format=@%H %at", "--numstat"}
	if email := gitOut(root, "config", "user.email"); email != "" {
		args = append(args, "--author=<"+email+">")
	}
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return nil
	}
	var list []commit
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(l, "@") {
			f := strings.Fields(l[1:])
			if len(f) != 2 {
				continue
			}
			at, _ := strconv.ParseInt(f[1], 10, 64)
			list = append(list, commit{Sha: f[0], Time: time.Unix(at, 0).UTC()})
			continue
		}
		f := strings.Fields(l)
		if len(f) < 3 || len(list) == 0 {
			continue
		}
		a, _ := strconv.Atoi(f[0]) // "-" for a binary file reads as 0
		r, _ := strconv.Atoi(f[1])
		list[len(list)-1].Added += a
		list[len(list)-1].Removed += r
	}
	return list
}

// queueCommits puts a commit record in the outbox for each commit made since
// the last sync in every repository with a remote that raws worked in, so the
// site can link them and check them against the host. It returns how many.
func queueCommits(raws []sources.Raw, now time.Time) int {
	stamp := filepath.Join(dataDir(), "last-commits")
	since := now.AddDate(-1, 0, 0)
	if info, err := os.Stat(stamp); err == nil {
		since = info.ModTime().Add(-time.Hour)
	}
	resolve := localProjects()
	seen := map[string]bool{}
	n := 0
	for _, r := range raws {
		p, root := resolve(r)
		// A project named by a folder, its own or a remote's on this computer
		// (keyed ~/repos/x or /srv/x), has no host to check against.
		if p.Key == folderKey(root) || seen[root] || !onHost(p.Key) {
			continue
		}
		seen[root] = true
		n += queueCommitsOf(localOutbox, root, p.Key, since)
	}
	os.WriteFile(stamp, nil, 0o600)
	return n
}

// onHost reports whether a project key names a repository on a host, such as
// github.com/kid/app, which the site can check commits against, rather than
// a folder.
func onHost(key string) bool {
	return strings.Contains(key, "/") && !strings.HasPrefix(key, "/") && !strings.HasPrefix(key, "~/")
}

// queueCommitsOf puts a commit record in outbox for each of the person's
// commits in the repository at root, keyed key, since t. It returns how many.
func queueCommitsOf(outbox, root, key string, since time.Time) int {
	n := 0
	for _, c := range listCommits(root, since) {
		ev := sources.JournalEvent{Time: c.Time, Tool: "git", Event: "commit", Session: c.Sha, Git: key, Sha: c.Sha, Added: c.Added, Removed: c.Removed}
		if queueRelay(outbox, ev) == nil {
			n++
		}
	}
	return n
}

// queueRelayCommits does for a cloud thread what a sync does on a computer:
// when a turn ends, it puts the person's commits in the thread's repository
// since the last turn, or in the past year the first time, in the relay
// outbox, so the site links them and checks them against the host. Each
// repository keeps its own stamp, since one data folder can serve several.
func queueRelayCommits(root, key string, now time.Time) int {
	if root == "" || !onHost(key) {
		return 0
	}
	stamp := filepath.Join(dataDir(), fmt.Sprintf("last-commits-%x", sha256.Sum256([]byte(root)))[:len("last-commits-")+12])
	since := now.AddDate(-1, 0, 0)
	if info, err := os.Stat(stamp); err == nil {
		since = info.ModTime().Add(-time.Hour)
	}
	n := queueCommitsOf(relayOutbox, root, key, since)
	os.WriteFile(stamp, nil, 0o600)
	return n
}
