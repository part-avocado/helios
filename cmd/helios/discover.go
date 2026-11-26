package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/part-avocado/helios/internal/sources"
)

// A location is one place a tool keeps session logs.
type location struct {
	Tool   string   // display name
	Dir    string   // the tool's config directory
	Logs   []string // log roots under Dir
	Parser sources.Parser
}

type found struct {
	location
	Sessions int
	Newest   time.Time
}

// locations lists every directory where Claude Code or Codex may keep logs.
// Flags override the defaults; both take comma-separated lists. Defaults
// cover custom config dirs (CLAUDE_CONFIG_DIR may list several), the
// standard dotfile dirs, and the XDG config dir newer Claude Code versions use.
func locations(claudeFlag, codexFlag string) []location {
	home, _ := os.UserHomeDir()
	xdg := os.Getenv("XDG_CONFIG_HOME")
	if xdg == "" {
		xdg = filepath.Join(home, ".config")
	}
	claude := pick(claudeFlag, os.Getenv("CLAUDE_CONFIG_DIR"), filepath.Join(home, ".claude"), filepath.Join(xdg, "claude"))
	codex := pick(codexFlag, os.Getenv("CODEX_HOME"), filepath.Join(home, ".codex"))

	parseClaude := sources.ClaudeParser() // shared, so copied usage counts once across dirs
	var out []location
	for _, d := range claude {
		out = append(out, location{"Claude Code", d, []string{filepath.Join(d, "projects")}, parseClaude})
	}
	for _, d := range codex {
		out = append(out, location{"Codex", d, []string{filepath.Join(d, "sessions"), filepath.Join(d, "archived_sessions")}, sources.ParseCodex})
	}
	return out
}

// pick returns the flag's directories when set, else the env var's plus the
// defaults, without duplicates.
func pick(flag, env string, defaults ...string) []string {
	list := defaults
	if flag != "" {
		list = nil
		env = flag
	}
	var out []string
	seen := map[string]bool{}
	for _, d := range append(strings.Split(env, ","), list...) {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		key := d
		if real, err := filepath.EvalSymlinks(d); err == nil {
			key = real
		}
		if !seen[key] {
			seen[key] = true
			out = append(out, d)
		}
	}
	return out
}

// load parses every location. A file reached through two locations, such as
// a symlinked config dir, is read once. Files last written before since are
// skipped; the zero time reads every file. When this is a terminal, a
// progress bar shows how far along the reading is.
func load(locs []location, since time.Time) (raws []sources.Raw, stats []found, warnings []string) {
	type file struct {
		loc  int
		path string
	}
	var files []file
	seen := map[string]bool{}
	for i, loc := range locs {
		for _, root := range loc.Logs {
			paths, w := sources.List(root, since)
			warnings = append(warnings, w...)
			for _, p := range paths {
				if !seen[p] {
					seen[p] = true
					files = append(files, file{i, p})
				}
			}
		}
	}
	stats = make([]found, len(locs))
	for i, loc := range locs {
		stats[i].location = loc
	}
	bar := newBar("Reading logs", int64(len(files)), "files")
	defer bar.done()
	for n, f := range files {
		r, w := sources.ParseFile(f.path, locs[f.loc].Parser)
		if w != "" {
			warnings = append(warnings, w)
		}
		if len(r.Events) > 0 {
			raws = append(raws, r)
			st := &stats[f.loc]
			st.Sessions++
			if last := r.Events[len(r.Events)-1].Time; last.After(st.Newest) {
				st.Newest = last
			}
		}
		bar.set(int64(n + 1))
	}
	return raws, stats, warnings
}

func exists(dir string) bool {
	st, err := os.Stat(dir)
	return err == nil && st.IsDir()
}

// mergeJournal adds sessions that hooks recorded but that have no transcript,
// such as ones Claude Code already deleted. A session with a transcript keeps
// the transcript's fuller record, so nothing is counted twice.
func mergeJournal(raws, journal []sources.Raw) []sources.Raw {
	have := map[string]bool{}
	for _, r := range raws {
		have[r.Tool+"\x00"+r.ID] = true
	}
	for _, j := range journal {
		if !have[j.Tool+"\x00"+j.ID] {
			raws = append(raws, j)
		}
	}
	return raws
}
