package main

import (
	"bufio"
	"maps"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
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
