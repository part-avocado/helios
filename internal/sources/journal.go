package sources

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/part-avocado/teardrop/internal/textscore"
	"github.com/part-avocado/teardrop/internal/timeline"
)

// JournalEvent is one line of the hook journal: an event that a harness hook
// reported as it happened. It never holds prompt text, only its text score.
type JournalEvent struct {
	Time    time.Time `json:"t"`
	Tool    string    `json:"tool"`
	Event   string    `json:"event"`
	Human   bool      `json:"human,omitempty"` // a prompt the person submitted
	Session string    `json:"session"`
	Cwd     string    `json:"cwd,omitempty"`
	Judged  int       `json:"judged,omitempty"` // text score of a human prompt
	Real    int       `json:"real,omitempty"`
}

// AppendJournal adds ev to the month's journal file in dir. Each event is
// written with one append, so hooks from parallel sessions don't interleave.
func AppendJournal(dir string, ev JournalEvent) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	name := filepath.Join(dir, "events-"+ev.Time.UTC().Format("2006-01")+".jsonl")
	f, err := os.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// ReadJournal reads every journal file in dir into one Raw per session.
// A missing dir yields nothing; unreadable files are reported in warnings.
func ReadJournal(dir string) (out []Raw, warnings []string) {
	files, _ := filepath.Glob(filepath.Join(dir, "events-*.jsonl")) // sorted, so months are in order
	byKey := map[string]*Raw{}
	var order []string
	for _, path := range files {
		f, err := os.Open(path)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("skipped %s: %v", path, err))
			continue
		}
		err = lines(f, func(b []byte) {
			var ev JournalEvent
			if json.Unmarshal(b, &ev) != nil || ev.Session == "" || ev.Time.IsZero() {
				return
			}
			key := ev.Tool + "\x00" + ev.Session
			r := byKey[key]
			if r == nil {
				r = &Raw{Tool: ev.Tool, ID: ev.Session, Path: path + "#" + ev.Session}
				byKey[key] = r
				order = append(order, key)
			}
			if r.Cwd == "" {
				r.Cwd = ev.Cwd
			}
			e := timeline.Event{Time: ev.Time, Kind: timeline.Agent}
			if !ev.Human {
				r.Events = append(r.Events, e)
				return
			}
			e.Kind = timeline.Human
			if r.Scores == nil {
				r.Scores = map[int]textscore.Score{}
			}
			r.Scores[len(r.Events)] = textscore.Score{Judged: ev.Judged, Real: ev.Real}
			r.Events = append(r.Events, e)
		})
		f.Close()
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("skipped part of %s: %v", path, err))
		}
	}
	for _, k := range order {
		out = append(out, *byKey[k])
	}
	return out, warnings
}
