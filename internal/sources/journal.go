package sources

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/part-avocado/helios/internal/textscore"
	"github.com/part-avocado/helios/internal/timeline"
)

type JournalEvent struct {
	Time    time.Time `json:"t"`
	Tool    string    `json:"tool"`
	Event   string    `json:"event"`
	Human   bool      `json:"human,omitempty"`
	Session string    `json:"session"`
	Cwd     string    `json:"cwd,omitempty"`
	Git     string    `json:"git,omitempty"`
	Judged  int       `json:"judged,omitempty"`
	Real    int       `json:"real,omitempty"`
	Sim     uint64    `json:"sim,omitempty"`
	Low     bool      `json:"low,omitempty"`
	In      int64     `json:"in,omitempty"`
	Out     int64     `json:"out,omitempty"`
	Added   int       `json:"added,omitempty"`
	Removed int       `json:"removed,omitempty"`
	Sha     string    `json:"sha,omitempty"`
}

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

const lastEventTail = 256 << 10

func LastJournalEvent(dir string, at time.Time, tool, session string) (JournalEvent, bool) {
	var last JournalEvent
	f, err := os.Open(filepath.Join(dir, "events-"+at.UTC().Format("2006-01")+".jsonl"))
	if err != nil {
		return last, false
	}
	defer f.Close()
	if info, err := f.Stat(); err == nil && info.Size() > lastEventTail {
		f.Seek(-lastEventTail, io.SeekEnd)
	}
	b, _ := io.ReadAll(f)
	lines := bytes.Split(b, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		var ev JournalEvent
		if json.Unmarshal(lines[i], &ev) == nil && ev.Tool == tool && ev.Session == session {
			return ev, true
		}
	}
	return last, false
}

func ReadJournal(dir string) (out []Raw, warnings []string) {
	files, _ := filepath.Glob(filepath.Join(dir, "events-*.jsonl"))
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

func ReadJournalEvents(dir string, since time.Time) []JournalEvent {
	files, _ := filepath.Glob(filepath.Join(dir, "events-*.jsonl"))
	first := "events-" + since.UTC().Format("2006-01") + ".jsonl"
	seen := map[string]bool{}
	var out []JournalEvent
	for _, path := range files {
		if filepath.Base(path) < first {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		lines(f, func(b []byte) {
			var ev JournalEvent
			if json.Unmarshal(b, &ev) != nil || ev.Session == "" || ev.Time.Before(since) {
				return
			}
			once := ev.Tool + "\x00" + ev.Session + "\x00" + ev.Event + "\x00" + ev.Time.UTC().Format(time.RFC3339Nano)
			if !seen[once] {
				seen[once] = true
				out = append(out, ev)
			}
		})
		f.Close()
	}
	return out
}

type journal struct {
	byKey map[string]*Raw
	order []string
	seen  map[string]bool
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
			e.In, e.Out = max(0, ev.In), max(0, ev.Out)
			e.Added, e.Removed = max(0, ev.Added), max(0, ev.Removed)
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
