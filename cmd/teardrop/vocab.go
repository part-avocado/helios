package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/textscore"
	"github.com/part-avocado/teardrop/internal/timeline"
)

// The words of a project's own files make its identifiers real words, such
// as rtt from rttMs, which would otherwise read as mashing. Reading a repo
// takes too long for a hook, so a background sync writes each recent
// project's words to the data folder, and hooks and syncs only read them.
// A prompt in a project with no words saved yet is scored without them.
// The words stay on this computer.

const (
	vocabDir    = "vocab"
	vocabFresh  = 24 * time.Hour     // how often a project's words are read again
	vocabRecent = 7 * 24 * time.Hour // projects with activity this recent get their words saved
	vocabMax    = 20                 // projects one sync reads, at most
)

// vocabPath is where root's words are saved.
func vocabPath(root string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(root)))
	return filepath.Join(dataDir(), vocabDir, hex.EncodeToString(sum[:8]))
}

// saveVocabs saves the words of each root that is not saved within
// vocabFresh, up to vocabMax of them, most recent first.
func saveVocabs(roots []string) {
	saved := 0
	for _, root := range roots {
		if root == "" || saved == vocabMax {
			continue
		}
		path := vocabPath(root)
		if info, err := os.Stat(path); err == nil && time.Since(info.ModTime()) < vocabFresh {
			continue
		}
		saved++
		words := make([]string, 0, 1024)
		for w := range textscore.RepoVocab(root) {
			words = append(words, w)
		}
		slices.Sort(words)
		os.MkdirAll(filepath.Dir(path), 0o700)
		// Each word on its own line, with one before the first, so a lookup is one search for "\nword\n".
		os.WriteFile(path, []byte("\n"+strings.Join(words, "\n")+"\n"), 0o600)
	}
}

// vocabHits counts the words that root's saved words hold; 0 when none are saved.
func vocabHits(root string, words []string) int {
	if root == "" || len(words) == 0 {
		return 0
	}
	b, err := os.ReadFile(vocabPath(root))
	if err != nil {
		return 0
	}
	n := 0
	for _, w := range words {
		if strings.Contains(string(b), "\n"+w+"\n") {
			n++
		}
	}
	return n
}

// savedRoot returns the nearest folder at or above cwd whose words are
// saved, or "". It asks git nothing, so a hook stays fast.
func savedRoot(cwd string) string {
	if cwd == "" {
		return ""
	}
	for dir := filepath.Clean(cwd); ; {
		if _, err := os.Stat(vocabPath(dir)); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// recentRoots returns the project folders with activity within
// vocabRecent of now, in transcripts or the journal, most recent first.
func recentRoots(transcripts []sources.Raw, journal []sources.JournalEvent, resolve func(sources.Raw) (timeline.Project, string), now time.Time) []string {
	last := map[string]time.Time{}
	note := func(r sources.Raw, t time.Time) {
		if now.Sub(t) > vocabRecent {
			return
		}
		if _, root := resolve(r); root != "" && t.After(last[root]) {
			last[root] = t
		}
	}
	for _, r := range transcripts {
		for _, e := range r.Events {
			note(sources.Raw{Tool: r.Tool, ID: r.ID, Cwd: r.Cwd, GitURL: r.GitURL}, e.Time)
		}
	}
	for _, ev := range journal {
		note(sources.Raw{Tool: ev.Tool, ID: ev.Session, Cwd: ev.Cwd, GitURL: ev.Git}, ev.Time)
	}
	roots := make([]string, 0, len(last))
	for root := range last {
		roots = append(roots, root)
	}
	slices.SortFunc(roots, func(a, b string) int { return last[b].Compare(last[a]) })
	return roots
}
