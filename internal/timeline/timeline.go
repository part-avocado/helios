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
	Noise
	Repeat
	Autopilot
)

type Event struct {
	Time                 time.Time
	Kind                 Kind
	In                   int64
	Out                  int64
	Added, Removed, Kept int
}

type Project struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type Session struct {
	Tool    string
	ID      string
	Path    string
	Project Project
	Events  []Event
}

type Rules struct {
	ComposeCap time.Duration
	WatchFull  time.Duration
	WatchCap   time.Duration
	BlockGap   time.Duration
}

func (r Rules) watched(a, b time.Duration) time.Duration {
	full := min(r.WatchFull, r.WatchCap)
	at := func(t time.Duration) time.Duration {
		t = min(t, r.WatchCap)
		if t <= full {
			return t
		}
		return full + (t-full)/2
	}
	return at(b) - at(a)
}

var DefaultRules = Rules{
	ComposeCap: 5 * time.Minute,
	WatchFull:  3 * time.Minute,
	WatchCap:   5 * time.Minute,
	BlockGap:   15 * time.Minute,
}

type Interval struct {
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
}

type Seconds time.Duration

func (s Seconds) MarshalJSON() ([]byte, error) {
	return []byte(strconv.FormatInt(int64(time.Duration(s)/time.Second), 10)), nil
}

func (s *Seconds) UnmarshalJSON(b []byte) error {
	n, err := strconv.ParseInt(string(b), 10, 64)
	*s = Seconds(time.Duration(n) * time.Second)
	return err
}

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
			case e.Kind == Human && ev[i-1].Kind == Human:
				start, end = prev, prev.Add(min(e.Time.Sub(prev), r.WatchFull, r.WatchCap))
			case e.Kind == Human && (ev[i-1].Kind != Agent || !haveHuman):
			case e.Kind == Human:
				start, end = later(prev, e.Time.Add(-r.ComposeCap)), e.Time
			case haveHuman:
				start = prev
				end = start.Add(r.watched(prev.Sub(lastHuman), earlier(e.Time, lastHuman.Add(r.WatchCap)).Sub(lastHuman)))
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
	Lines
	Tools []string `json:"tools"`
}

type Lines struct {
	Added   int `json:"lines_added"`
	Removed int `json:"lines_removed"`
	Kept    int `json:"lines_kept"`
}

func (l *Lines) add(e Event) {
	l.Added, l.Removed, l.Kept = l.Added+e.Added, l.Removed+e.Removed, l.Kept+e.Kept
}

type ProjectTotal struct {
	Project          Project `json:"project"`
	Engaged          Seconds `json:"engaged_seconds"`
	SessionTime      Seconds `json:"session_seconds"`
	Prompts          int     `json:"prompts"`
	NoisePrompts     int     `json:"noise_prompts"`
	RepeatPrompts    int     `json:"repeat_prompts"`
	AutopilotPrompts int     `json:"autopilot_prompts"`
	In               int64   `json:"tokens_in"`
	Out              int64   `json:"tokens_out"`
	Lines
	Committed int `json:"lines_committed"`
}

type Report struct {
	Blocks   []Block        `json:"blocks"`
	Projects []ProjectTotal `json:"projects"`
	Engaged  Seconds        `json:"engaged_seconds"`
	Days     []Day          `json:"days"`
}

type Day struct {
	Date    string  `json:"date"`
	Engaged Seconds `json:"engaged_seconds"`
}

func Days(iv []Interval, loc *time.Location) []Day {
	var out []Day
	for _, x := range merge(iv, 0) {
		for s := x.Start.In(loc); s.Before(x.End); {
			y, m, d := s.Date()
			next := earlier(time.Date(y, m, d+1, 0, 0, 0, 0, loc), x.End)
			date := s.Format("2006-01-02")
			if n := len(out); n > 0 && out[n-1].Date == date {
				out[n-1].Engaged += Seconds(next.Sub(s))
			} else {
				out = append(out, Day{date, Seconds(next.Sub(s))})
			}
			s = next
		}
	}
	return out
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
		skipped  [3]int
		usage    []Event
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
			case Noise, Repeat, Autopilot:
				a.skipped[e.Kind-Noise]++
			}
			if e.In > 0 || e.Out > 0 || e.Added > 0 || e.Removed > 0 {
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
			Project:          a.project,
			Engaged:          Seconds(total(engaged)),
			SessionTime:      Seconds(total(merge(a.spans, 0))),
			Prompts:          len(a.prompts),
			NoisePrompts:     a.skipped[0],
			RepeatPrompts:    a.skipped[1],
			AutopilotPrompts: a.skipped[2],
		}
		for _, e := range a.usage {
			pt.In, pt.Out = pt.In+e.In, pt.Out+e.Out
			pt.Lines.add(e)
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
					b.Lines.add(e)
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
	rep.Days = Days(everything, time.Local)
	return rep
}

func Engaged(sessions []Session, r Rules) []Interval {
	var all []Interval
	for _, s := range sessions {
		all = append(all, Credit(s.Events, r)...)
	}
	return merge(all, 0)
}

func Union(iv []Interval) []Interval { return merge(iv, 0) }

func Total(iv []Interval) time.Duration { return total(merge(iv, 0)) }

func Overlap(a, b []Interval) time.Duration {
	a, b = merge(a, 0), merge(b, 0)
	var d time.Duration
	for i, j := 0, 0; i < len(a) && j < len(b); {
		if s, e := later(a[i].Start, b[j].Start), earlier(a[i].End, b[j].End); e.After(s) {
			d += e.Sub(s)
		}
		if a[i].End.Before(b[j].End) {
			i++
		} else {
			j++
		}
	}
	return d
}

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
