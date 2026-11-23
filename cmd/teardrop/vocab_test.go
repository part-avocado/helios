package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/textscore"
	"github.com/part-avocado/teardrop/internal/timeline"
)

// A project's own identifiers count as real words in what hooks and syncs
// send the site, once a sync has saved the project's words. Before that,
// a hook scores without them and never reads the project itself.
func TestProjectWordsReachRecords(t *testing.T) {
	data, repo := t.TempDir(), t.TempDir()
	t.Setenv("TEARDROP_DATA_DIR", data)
	os.WriteFile(filepath.Join(repo, "net.go"), []byte("var rttMs = measure()"), 0o644)
	sub := filepath.Join(repo, "src", "net")
	os.MkdirAll(sub, 0o755)
	const text = "make rtt lower please" // rtt has no vowel, so without the project it reads as mashed

	prompt := func(cwd string) sources.JournalEvent {
		var in hookInput
		b, _ := json.Marshal(map[string]string{"session_id": "s", "hook_event_name": "UserPromptSubmit", "prompt": text, "cwd": cwd})
		json.Unmarshal(b, &in)
		ev, _, _ := hookRecord("claude-code", "", in, time.Now())
		return ev
	}
	if ev := prompt(sub); ev.Judged != 4 || ev.Real != 3 {
		t.Fatalf("before any sync: judged %d real %d, want 4 and 3", ev.Judged, ev.Real)
	}
	if _, err := os.Stat(filepath.Join(data, vocabDir)); err == nil {
		t.Error("a hook saved the project's words; only a sync may read the project")
	}

	saveVocabs([]string{repo})
	if ev := prompt(sub); ev.Real != 4 {
		t.Errorf("hook in a folder of the project, after a sync: real %d, want 4", ev.Real)
	}
	if ev := prompt(t.TempDir()); ev.Real != 3 {
		t.Errorf("hook outside the project: real %d, want 3", ev.Real)
	}

	// A transcript turn no hook saw gets the same help.
	at := time.Now().Add(-time.Hour)
	transcript := sources.Raw{Tool: "claude-code", ID: "t", Cwd: sub, Events: []timeline.Event{{Time: at, Kind: timeline.Human}}, Scores: map[int]textscore.Score{0: textscore.Analyze(text)}}
	for _, c := range []struct {
		root string
		real int
	}{{repo, 4}, {t.TempDir(), 3}} {
		resolve := func(sources.Raw) (timeline.Project, string) { return timeline.Project{Key: "k"}, c.root }
		recs := syncRecords([]sources.Raw{transcript}, nil, resolve, at.Add(-time.Minute))
		if len(recs) != 1 || recs[0].Judged != 4 || recs[0].Real != c.real {
			t.Errorf("synced transcript prompt with root %s: %+v, want real %d", c.root, recs, c.real)
		}
	}
}

// A sync saves the words of the projects worked on in the last week, most
// recent first, and not of older ones.
func TestRecentRoots(t *testing.T) {
	now := time.Now()
	raw := func(cwd string, ago time.Duration) sources.Raw {
		return sources.Raw{Cwd: cwd, Events: []timeline.Event{{Time: now.Add(-ago)}}}
	}
	journal := []sources.JournalEvent{{Cwd: "/c", Time: now.Add(-time.Minute)}, {Cwd: "/old2", Time: now.Add(-30 * 24 * time.Hour)}}
	resolve := func(r sources.Raw) (timeline.Project, string) { return timeline.Project{}, r.Cwd }
	got := recentRoots([]sources.Raw{raw("/a", 3*time.Hour), raw("/old", 8*24*time.Hour), raw("/b", time.Hour)}, journal, resolve, now)
	if want := []string{"/c", "/b", "/a"}; !slices.Equal(got, want) {
		t.Errorf("roots %v, want %v", got, want)
	}
}
