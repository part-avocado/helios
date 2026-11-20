package timeline

import (
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
