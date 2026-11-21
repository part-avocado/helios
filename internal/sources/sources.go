// Package sources reads AI harness session logs into timeline sessions.
//
// Parsers read timestamps, who produced each record, token counts, and the
// working directory. Prompt text is scored for the text check and then
// dropped; it is never stored or printed.
package sources

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/part-avocado/teardrop/internal/textscore"
	"github.com/part-avocado/teardrop/internal/timeline"
)

// Raw is a parsed session before its working directory is resolved to a project.
type Raw struct {
	Tool   string
	ID     string
	Path   string // the log file, with symlinks resolved
	Cwd    string
	GitURL string // remote URL when the log records one
	Events []timeline.Event
	// Scores holds the text score of each human prompt, by index into Events.
	Scores map[int]textscore.Score
	// Edits holds the file changes made by agent events, by index into Events.
	// Each event's Added and Removed already hold the counts.
	Edits map[int]Edit
}

// addAgent appends an agent event carrying edit e, if it changed any lines.
func (r *Raw) addAgent(ev timeline.Event, e Edit) {
	if e.Added > 0 || e.Removed > 0 {
		if r.Edits == nil {
			r.Edits = map[int]Edit{}
		}
		r.Edits[len(r.Events)] = e
		ev.Added, ev.Removed = e.Added, e.Removed
	}
	r.Events = append(r.Events, ev)
}

func (r *Raw) addPrompt(ev timeline.Event, text string) {
	if r.Scores == nil {
		r.Scores = map[int]textscore.Score{}
	}
	r.Scores[len(r.Events)] = textscore.Analyze(text)
	r.Events = append(r.Events, ev)
}

// Parser reads one log file. id is the file name without its extensions.
type Parser func(r io.Reader, id string) (Raw, error)

// List returns the paths of the .jsonl and .jsonl.zst files under root, in
// the order Walk reads them. Files last written before since are left out;
// the zero time lists every file. A missing root yields nothing. Directories
// that cannot be read are reported in warnings.
func List(root string, since time.Time) (paths []string, warnings []string) {
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if !os.IsNotExist(err) {
				warnings = append(warnings, fmt.Sprintf("skipped %s: %v", path, err))
			}
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if d.IsDir() || !(strings.HasSuffix(name, ".jsonl") || strings.HasSuffix(name, ".jsonl.zst")) {
			return nil
		}
		if !since.IsZero() {
			// Stat follows symlinks and asks the file itself, which a directory listing may lag behind.
			if st, err := os.Stat(path); err == nil && st.ModTime().Before(since) {
				return nil
			}
		}
		paths = append(paths, path)
		return nil
	})
	return paths, warnings
}

// ParseFile parses one log file with parse. A file that cannot be read or
// parsed is reported in the warning, and what could be parsed is returned.
func ParseFile(path string, parse Parser) (r Raw, warning string) {
	r, err := parseFile(path, parse)
	if err != nil {
		warning = fmt.Sprintf("skipped %s: %v", path, err)
	}
	return r, warning
}

// Walk parses every .jsonl and .jsonl.zst file under root. A missing root
// yields nothing. A file that cannot be read or parsed is reported in
// warnings and skipped, so one bad file never stops a run. Files last
// written before since are not read; the zero time reads every file.
func Walk(root string, parse Parser, since time.Time) (out []Raw, warnings []string) {
	paths, warnings := List(root, since)
	for _, path := range paths {
		r, w := ParseFile(path, parse)
		if w != "" {
			warnings = append(warnings, w)
		}
		if len(r.Events) > 0 {
			out = append(out, r)
		}
	}
	return out, warnings
}

// openLog opens a log file, decompressing a .zst one.
func openLog(path string) (io.Reader, func(), error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	if !strings.HasSuffix(path, ".zst") {
		return f, func() { f.Close() }, nil
	}
	zr, err := zstd.NewReader(f, zstd.WithDecoderLowmem(true))
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return zr, func() { zr.Close(); f.Close() }, nil
}

// ReadLog returns a log file's contents, decompressed.
func ReadLog(path string) ([]byte, error) {
	r, done, err := openLog(path)
	if err != nil {
		return nil, err
	}
	defer done()
	return io.ReadAll(r)
}

func parseFile(path string, parse Parser) (Raw, error) {
	rd, done, err := openLog(path)
	if err != nil {
		return Raw{}, err
	}
	defer done()
	id := strings.TrimSuffix(strings.TrimSuffix(filepath.Base(path), ".zst"), ".jsonl")
	r, err := parse(rd, id)
	if real, e := filepath.EvalSymlinks(path); e == nil {
		r.Path = real
	} else {
		r.Path = path
	}
	return r, err // keep the events read before an error, such as a truncated archive
}

// lines calls fn with each JSON line of r. Lines that are not valid JSON,
// such as a line still being written, are skipped. Lines have no length limit.
func lines(r io.Reader, fn func([]byte)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		b, err := br.ReadBytes('\n')
		if b = bytes.TrimSpace(b); len(b) > 0 && json.Valid(b) {
			fn(b)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func parseTime(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil && t.Year() > 2000
}
