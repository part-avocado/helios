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

// Walk parses every .jsonl and .jsonl.zst file under root. A missing root
// yields nothing. A file that cannot be read or parsed is reported in
// warnings and skipped, so one bad file never stops a run.
func Walk(root string, parse Parser) (out []Raw, warnings []string) {
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
		r, err := parseFile(path, parse)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("skipped %s: %v", path, err))
		}
		if len(r.Events) > 0 {
			out = append(out, r)
		}
		return nil
	})
	return out, warnings
}

func parseFile(path string, parse Parser) (Raw, error) {
	f, err := os.Open(path)
	if err != nil {
		return Raw{}, err
	}
	defer f.Close()
	var rd io.Reader = f
	id := strings.TrimSuffix(filepath.Base(path), ".zst")
	if id != filepath.Base(path) {
		zr, err := zstd.NewReader(f, zstd.WithDecoderLowmem(true))
		if err != nil {
			return Raw{}, err
		}
		defer zr.Close()
		rd = zr
	}
	r, err := parse(rd, strings.TrimSuffix(id, ".jsonl"))
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
