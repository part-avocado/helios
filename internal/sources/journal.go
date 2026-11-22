package sources

import (
	"encoding/json"
	"fmt"
	"io"
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
	Git     string    `json:"git,omitempty"`    // the folder's repository, when the event was recorded on another machine
	Judged  int       `json:"judged,omitempty"` // text score of a human prompt
	Real    int       `json:"real,omitempty"`
	Sim     uint64    `json:"sim,omitempty"` // prompt fingerprint, for finding repeats
	Low     bool      `json:"low,omitempty"` // prompt only steers ("continue", "fix it")
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
	j := journal{byKey: map[string]*Raw{}}
	for _, path := range files {
		f, err := os.Open(path)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("skipped %s: %v", path, err))
			continue
		}
		err = j.read(f, path)
		f.Close()
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("skipped part of %s: %v", path, err))
		}
	}
	return j.raws(), warnings
}

// ParseJournal reads journal lines from r, such as those a submission holds,
// into one Raw per session.
func ParseJournal(r io.Reader, name string) ([]Raw, error) {
	j := journal{byKey: map[string]*Raw{}}
	err := j.read(r, name)
	return j.raws(), err
}

// JournalLines returns the journal lines of one session, as written.
func JournalLines(dir, tool, session string) []byte {
	files, _ := filepath.Glob(filepath.Join(dir, "events-*.jsonl"))
	var out []byte
	for _, path := range files {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		lines(f, func(b []byte) {
			var ev JournalEvent
			if json.Unmarshal(b, &ev) == nil && ev.Tool == tool && ev.Session == session {
				out = append(append(out, b...), '\n')
			}
		})
		f.Close()
	}
	return out
}

type journal struct {
	byKey map[string]*Raw
	order []string
	seen  map[string]bool // events read so far, since one taken from the site twice is written twice
}

func (j *journal) read(f io.Reader, path string) error {
	return lines(f, func(b []byte) {
		var ev JournalEvent
		if json.Unmarshal(b, &ev) != nil || ev.Session == "" || ev.Time.IsZero() {
			return
		}
		key := ev.Tool + "\x00" + ev.Session
		once := key + "\x00" + ev.Event + "\x00" + ev.Time.UTC().Format(time.RFC3339Nano)
		if j.seen[once] {
			return
		}
		if j.seen == nil {
			j.seen = map[string]bool{}
		}
		j.seen[once] = true
		r := j.byKey[key]
		if r == nil {
			r = &Raw{Tool: ev.Tool, ID: ev.Session, Path: path + "#" + ev.Session}
			j.byKey[key] = r
			j.order = append(j.order, key)
		}
		if r.Cwd == "" {
			r.Cwd = ev.Cwd
		}
		if r.GitURL == "" {
			r.GitURL = ev.Git
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
		r.Scores[len(r.Events)] = textscore.Score{Judged: ev.Judged, Real: ev.Real, Sim: textscore.Fingerprint(ev.Sim), Low: ev.Low}
		r.Events = append(r.Events, e)
	})
}

func (j *journal) raws() []Raw {
	var out []Raw
	for _, k := range j.order {
		out = append(out, *j.byKey[k])
	}
	return out
}
