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
		{Tool: "codex", Project: a, Events: []Event{at(52, Agent), at(0, Human), at(1, Agent), at(30, Agent), at(50, Human)}},
		{Tool: "claude-code", Project: a, Events: []Event{at(1, Human), at(3, Agent)}},
		{Tool: "codex", Project: b, Events: []Event{at(0, Human), at(3, Agent)}},
		{Tool: "codex", Project: b, Events: []Event{at(30, Agent), at(34, Noise), at(36, Agent)}},
		{Tool: "codex", Project: b, Events: []Event{at(200, Agent), at(260, Agent)}},
	}, DefaultRules)

	min := func(s Seconds) int { return int(time.Duration(s) / time.Minute) }
	if len(rep.Projects) != 2 || rep.Projects[0].Project != a || min(rep.Projects[0].Engaged) != 11 || rep.Projects[0].Prompts != 3 {
		t.Fatalf("project a: %+v", rep.Projects)
	}
	if min(rep.Projects[0].SessionTime) != 52 {
		t.Errorf("project a session time = %dm, want 52m", min(rep.Projects[0].SessionTime))
	}
	if min(rep.Projects[1].Engaged) != 3 {
		t.Errorf("project b engaged = %dm, want 3m", min(rep.Projects[1].Engaged))
	}
	if min(rep.Engaged) != 11 {
		t.Errorf("total engaged = %dm, want 11m", min(rep.Engaged))
	}

	var got []string
	for _, bl := range rep.Blocks {
		if bl.Project == a {
			got = append(got, bl.Start.Format("15:04")+"-"+bl.End.Format("15:04")+" "+time.Duration(bl.Engaged).String())
			if bl.Start.Equal(t0) && (bl.Prompts != 2 || len(bl.Tools) != 2) {
				t.Errorf("first block: prompts %d tools %v, want 2 prompts and both tools", bl.Prompts, bl.Tools)
			}
		}
	}
	want := []string{"15:00-15:04 4m0s", "15:45-15:52 7m0s"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("blocks of a = %v, want %v", got, want)
	}
}

func TestOverlap(t *testing.T) {
	at := func(m int) time.Time { return time.Date(2026, 11, 20, 10, m, 0, 0, time.UTC) }
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

func TestDays(t *testing.T) {
	loc := time.FixedZone("UTC+2", 2*60*60)
	utc := func(h, m int) time.Time { return time.Date(2026, 11, 20, h, m, 0, 0, time.UTC) }
	got := Days([]Interval{{utc(21, 40), utc(22, 20)}, {utc(21, 30), utc(21, 50)}}, loc)
	want := []Day{{"2026-11-20", Seconds(30 * time.Minute)}, {"2026-11-21", Seconds(20 * time.Minute)}}
	if !slices.Equal(got, want) {
		t.Errorf("Days = %v, want %v", got, want)
	}
}

func TestInterruptedTurn(t *testing.T) {
	sec := func(s int, k Kind) Event { return Event{Time: t0.Add(time.Duration(s) * time.Second), Kind: k} }
	for _, c := range []struct {
		name string
		ev   []Event
		want time.Duration
	}{
		{"a short interrupted turn earns its gap", []Event{sec(0, Human), sec(40, Human)}, 40 * time.Second},
		{"a long one earns WatchFull, not the watch window or compose time", []Event{sec(0, Human), sec(3600, Human)}, 3 * time.Minute},
		{"a skipped prompt in the middle earns the watch window once, and no compose time", []Event{sec(0, Human), sec(299, Noise), sec(300, Human), sec(599, Noise), sec(600, Human)}, 2*4*time.Minute - time.Second},
		{"a first prompt after a skipped one earns nothing", []Event{sec(0, Noise), sec(100, Human)}, 0},
	} {
		if got := Total(Credit(c.ev, DefaultRules)); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	var ev []Event
	for i := 0; i <= 12; i++ {
		ev = append(ev, at(5*i, Human))
	}
	if got := Total(Credit(ev, DefaultRules)); got != 36*time.Minute {
		t.Errorf("prompts every 5 minutes earned %v of an hour, want 36m", got)
	}
}
