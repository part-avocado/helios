package timeline

import (
	"slices"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC)

func at(min int, k Kind) Event { return Event{Time: t0.Add(time.Duration(min) * time.Minute), Kind: k} }

func TestBuild(t *testing.T) {
	a := Project{Key: "a", Name: "a"}
	b := Project{Key: "b", Name: "b"}
	rep := Build([]Session{
		// Prompt at 0, agent runs until 30 (credited only to 10, the watch cap),
		// next prompt at 50 (credited 45–50, the compose cap), agent answers at 52.
		{Tool: "codex", Project: a, Events: []Event{at(52, Agent), at(0, Human), at(1, Agent), at(30, Agent), at(50, Human)}},
		// A parallel session on the same project, inside 0–10: adds no time.
		{Tool: "claude-code", Project: a, Events: []Event{at(5, Human), at(8, Agent)}},
		// Another project at the same time: counts for b, but once in the total.
		{Tool: "codex", Project: b, Events: []Event{at(0, Human), at(3, Agent)}},
		// A gibberish prompt at 30 neither earns compose time nor extends the watch window.
		{Tool: "codex", Project: b, Events: []Event{at(30, Agent), at(34, Noise), at(36, Agent)}},
		// An agent working with no human input earns nothing.
		{Tool: "codex", Project: b, Events: []Event{at(200, Agent), at(260, Agent)}},
	}, DefaultRules)

	min := func(s Seconds) int { return int(time.Duration(s) / time.Minute) }
	if len(rep.Projects) != 2 || rep.Projects[0].Project != a || min(rep.Projects[0].Engaged) != 17 || rep.Projects[0].Prompts != 3 {
		t.Fatalf("project a: %+v", rep.Projects)
	}
	if min(rep.Projects[0].SessionTime) != 52 {
		t.Errorf("project a session time = %dm, want 52m", min(rep.Projects[0].SessionTime))
	}
	if min(rep.Projects[1].Engaged) != 3 {
		t.Errorf("project b engaged = %dm, want 3m", min(rep.Projects[1].Engaged))
	}
	if min(rep.Engaged) != 17 {
		t.Errorf("total engaged = %dm, want 17m", min(rep.Engaged))
	}

	// Project a splits into 0–10 and 45–52 (35m apart, over the 15m block gap).
	var got []string
	for _, bl := range rep.Blocks {
		if bl.Project == a {
			got = append(got, bl.Start.Format("15:04")+"-"+bl.End.Format("15:04")+" "+time.Duration(bl.Engaged).String())
			if bl.Start.Equal(t0) && (bl.Prompts != 2 || len(bl.Tools) != 2) {
				t.Errorf("first block: prompts %d tools %v, want 2 prompts and both tools", bl.Prompts, bl.Tools)
			}
		}
	}
	want := []string{"15:00-15:10 10m0s", "15:45-15:52 7m0s"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("blocks of a = %v, want %v", got, want)
	}
}

func TestOverlap(t *testing.T) {
	at := func(m int) time.Time { return time.Date(2026, 11, 20, 10, m, 0, 0, time.UTC) }
	// a: 0-10 and 20-30 (two pieces of one union); b: 5-25 split in two touching pieces.
	a := []Interval{{at(20), at(30)}, {at(0), at(10)}, {at(2), at(4)}}
	b := []Interval{{at(15), at(25)}, {at(5), at(15)}}
	if got := Overlap(a, b); got != 10*time.Minute {
		t.Errorf("Overlap = %v, want 10m (5-10 and 20-25)", got)
	}
	if got := Overlap(b, a); got != 10*time.Minute {
		t.Errorf("Overlap reversed = %v, want 10m", got)
	}
	if got := Total(a); got != 20*time.Minute {
		t.Errorf("Total = %v, want 20m", got)
	}
}

// Days splits engaged time at local midnight and counts overlap once.
func TestDays(t *testing.T) {
	loc := time.FixedZone("UTC+2", 2*60*60)
	utc := func(h, m int) time.Time { return time.Date(2026, 11, 20, h, m, 0, 0, time.UTC) }
	// In UTC+2 these are 23:40-00:20 and 23:30-23:50, overlapping from 23:40 to 23:50.
	got := Days([]Interval{{utc(21, 40), utc(22, 20)}, {utc(21, 30), utc(21, 50)}}, loc)
	want := []Day{{"2026-11-20", Seconds(30 * time.Minute)}, {"2026-11-21", Seconds(20 * time.Minute)}}
	if !slices.Equal(got, want) {
		t.Errorf("Days = %v, want %v", got, want)
	}
}
