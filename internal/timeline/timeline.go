// Package timeline turns AI coding sessions into the time a human was
// plausibly engaged with them.
//
// A session is a list of timestamped events, each either a human input
// (a prompt or an interrupt) or agent output (a reply, a tool call, a tool
// result). Time between two consecutive events is credited as follows:
//
//   - If the later event is a human input, the human was reading the agent's
//     output and writing the next prompt. Credit the last ComposeCap of the gap.
//   - If the later event is agent output, the agent was working. Credit the gap
//     only while it lies within WatchCap of the last human input, so a
//     long-running agent left alone does not earn time.
//
// Credited intervals of all sessions in a project are unioned, so parallel
// sessions on one project are not counted twice.
package timeline

import (
	"slices"
	"sort"
	"strconv"
	"time"
)

type Kind uint8

const (
	Agent Kind = iota
	Human
	Noise // a prompt that failed the text check: counted, but earns no time
)

type Event struct {
	Time time.Time
	Kind Kind
	In   int64 // tokens the model read for this record, cached ones included
	Out  int64 // tokens the model wrote
}

type Project struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type Session struct {
	Tool    string
	ID      string
	Project Project
	Events  []Event
}

type Rules struct {
	ComposeCap time.Duration // max credit for reading output and writing a prompt
	WatchCap   time.Duration // max credit for watching the agent after a human input
	BlockGap   time.Duration // engaged intervals closer than this are shown as one block
}

var DefaultRules = Rules{
	ComposeCap: 5 * time.Minute,
	WatchCap:   10 * time.Minute,
	BlockGap:   15 * time.Minute,
}

type Interval struct {
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
}

// Seconds is a duration that encodes to JSON as whole seconds.
type Seconds time.Duration

func (s Seconds) MarshalJSON() ([]byte, error) {
	return []byte(strconv.FormatInt(int64(time.Duration(s)/time.Second), 10)), nil
}

// Credit returns the merged intervals of one session in which the human was
// plausibly engaged.
func Credit(events []Event, r Rules) []Interval {
	ev := slices.Clone(events)
	sort.SliceStable(ev, func(i, j int) bool { return ev[i].Time.Before(ev[j].Time) })

	var out []Interval
	var lastHuman time.Time
	haveHuman := false
	for i, e := range ev {
		if i > 0 {
			prev := ev[i-1].Time
			var start, end time.Time
			switch {
			case e.Kind == Human:
				start, end = later(prev, e.Time.Add(-r.ComposeCap)), e.Time
			case haveHuman:
				start, end = prev, earlier(e.Time, lastHuman.Add(r.WatchCap))
			}
			if end.After(start) {
				out = append(out, Interval{start, end})
			}
		}
		if e.Kind == Human {
			lastHuman, haveHuman = e.Time, true
		}
	}
	return merge(out, 0)
}

type Block struct {
	Project Project   `json:"project"`
	Start   time.Time `json:"start"`
	End     time.Time `json:"end"`
	Engaged Seconds   `json:"engaged_seconds"`
	Prompts int       `json:"prompts"`
	In      int64     `json:"tokens_in"`
	Out     int64     `json:"tokens_out"`
	Tools   []string  `json:"tools"`
}

type ProjectTotal struct {
	Project      Project `json:"project"`
	Engaged      Seconds `json:"engaged_seconds"`
	SessionTime  Seconds `json:"session_seconds"` // union of first-to-last event spans
	Prompts      int     `json:"prompts"`
	NoisePrompts int     `json:"noise_prompts"`
	In           int64   `json:"tokens_in"`
	Out          int64   `json:"tokens_out"`
}

type Report struct {
	Blocks   []Block        `json:"blocks"`
	Projects []ProjectTotal `json:"projects"`
	Engaged  Seconds        `json:"engaged_seconds"` // across projects, overlap counted once
}

func Build(sessions []Session, r Rules) Report {
	type tagged struct {
		Interval
		tool string
	}
	type acc struct {
		project  Project
		credited []tagged
		spans    []Interval
		prompts  []time.Time
		noise    int
		usage    []Event // events that carry tokens
	}
	byKey := map[string]*acc{}
	var keys []string
	for _, s := range sessions {
		if len(s.Events) == 0 {
			continue
		}
		a := byKey[s.Project.Key]
		if a == nil {
			a = &acc{project: s.Project}
			byKey[s.Project.Key] = a
			keys = append(keys, s.Project.Key)
		}
		for _, iv := range Credit(s.Events, r) {
			a.credited = append(a.credited, tagged{iv, s.Tool})
		}
		first, last := s.Events[0].Time, s.Events[0].Time
		for _, e := range s.Events {
			first, last = earlier(first, e.Time), later(last, e.Time)
			switch e.Kind {
			case Human:
				a.prompts = append(a.prompts, e.Time)
			case Noise:
				a.noise++
			}
			if e.In > 0 || e.Out > 0 {
				a.usage = append(a.usage, e)
			}
		}
		a.spans = append(a.spans, Interval{first, last})
	}

	var rep Report
	var everything []Interval
	for _, k := range keys {
		a := byKey[k]
		var plain []Interval
		for _, t := range a.credited {
			plain = append(plain, t.Interval)
		}
		engaged := merge(plain, 0)
		everything = append(everything, engaged...)
		pt := ProjectTotal{
			Project:      a.project,
			Engaged:      Seconds(total(engaged)),
			SessionTime:  Seconds(total(merge(a.spans, 0))),
			Prompts:      len(a.prompts),
			NoisePrompts: a.noise,
		}
		for _, e := range a.usage {
			pt.In, pt.Out = pt.In+e.In, pt.Out+e.Out
		}
		rep.Projects = append(rep.Projects, pt)
		for _, span := range merge(engaged, r.BlockGap) {
			b := Block{Project: a.project, Start: span.Start, End: span.End}
			for _, iv := range engaged {
				if !iv.Start.Before(span.Start) && !iv.End.After(span.End) {
					b.Engaged += Seconds(iv.End.Sub(iv.Start))
				}
			}
			for _, p := range a.prompts {
				if !p.Before(span.Start) && !p.After(span.End) {
					b.Prompts++
				}
			}
			for _, e := range a.usage {
				if !e.Time.Before(span.Start) && !e.Time.After(span.End) {
					b.In, b.Out = b.In+e.In, b.Out+e.Out
				}
			}
			for _, t := range a.credited {
				if t.Start.Before(span.End) && t.End.After(span.Start) && !slices.Contains(b.Tools, t.tool) {
					b.Tools = append(b.Tools, t.tool)
				}
			}
			slices.Sort(b.Tools)
			rep.Blocks = append(rep.Blocks, b)
		}
	}
	sort.Slice(rep.Blocks, func(i, j int) bool { return rep.Blocks[i].Start.Before(rep.Blocks[j].Start) })
	sort.SliceStable(rep.Projects, func(i, j int) bool { return rep.Projects[i].Engaged > rep.Projects[j].Engaged })
	rep.Engaged = Seconds(total(merge(everything, 0)))
	return rep
}

// merge returns the union of intervals, also joining intervals separated by at most gap.
func merge(iv []Interval, gap time.Duration) []Interval {
	if len(iv) == 0 {
		return nil
	}
	s := slices.Clone(iv)
	sort.Slice(s, func(i, j int) bool { return s[i].Start.Before(s[j].Start) })
	out := []Interval{s[0]}
	for _, x := range s[1:] {
		last := &out[len(out)-1]
		if !x.Start.After(last.End.Add(gap)) {
			last.End = later(last.End, x.End)
		} else {
			out = append(out, x)
		}
	}
	return out
}

func total(iv []Interval) time.Duration {
	var d time.Duration
	for _, x := range iv {
		d += x.End.Sub(x.Start)
	}
	return d
}

func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func earlier(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
