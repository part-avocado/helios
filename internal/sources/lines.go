package sources

import (
	"encoding/json"
	"hash/fnv"
	"strings"
)

// Edit is the size of one change an agent made to files, read from its tool
// call. Hashes identify the added lines that can later be found in commits;
// the lines themselves are never kept.
type Edit struct {
	Added, Removed int
	Hashes         []uint64
}

// LineHash returns the hash used to match a written line with a committed
// one, ignoring indentation. Short lines such as "}" or "end" would match by
// chance, so they get no hash.
func LineHash(line string) (uint64, bool) {
	s := strings.TrimSpace(line)
	if len(s) < 6 {
		return 0, false
	}
	h := fnv.New64a()
	h.Write([]byte(s))
	return h.Sum64(), true
}

// CountLines counts the lines an edit from old to new adds and removes.
func CountLines(old, new string) (added, removed int) {
	e := diffLines(old, new)
	return e.Added, e.Removed
}

// diffLines counts the lines of new that old lacks and of old that new lacks,
// each line matched once. Blank lines are not counted.
func diffLines(old, new string) Edit {
	have := map[string]int{}
	for _, l := range strings.Split(old, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			have[l]++
		}
	}
	var e Edit
	for _, l := range strings.Split(new, "\n") {
		t := strings.TrimSpace(l)
		if t == "" {
			continue
		}
		if have[t] > 0 {
			have[t]--
			continue
		}
		e.add(l)
	}
	for _, n := range have {
		e.Removed += n
	}
	return e
}

func (e *Edit) add(line string) {
	e.Added++
	if h, ok := LineHash(line); ok {
		e.Hashes = append(e.Hashes, h)
	}
}

func (e *Edit) merge(o Edit) {
	e.Added, e.Removed = e.Added+o.Added, e.Removed+o.Removed
	e.Hashes = append(e.Hashes, o.Hashes...)
}

// claudeEdit reads the change a Claude Code Edit, MultiEdit, or Write tool
// call makes. Other tools change nothing.
func claudeEdit(name string, input json.RawMessage) (Edit, bool) {
	var in struct {
		Old     string `json:"old_string"`
		New     string `json:"new_string"`
		Content string `json:"content"`
		Edits   []struct {
			Old string `json:"old_string"`
			New string `json:"new_string"`
		} `json:"edits"`
	}
	if json.Unmarshal(input, &in) != nil {
		return Edit{}, false
	}
	switch name {
	case "Edit":
		return diffLines(in.Old, in.New), true
	case "MultiEdit":
		var e Edit
		for _, x := range in.Edits {
			e.merge(diffLines(x.Old, x.New))
		}
		return e, true
	case "Write":
		return diffLines("", in.Content), true
	}
	return Edit{}, false
}

// patchEdit counts the lines of a Codex apply_patch patch
// ("*** Begin Patch" ... "*** End Patch"): "+" lines are added and "-" lines removed.
func patchEdit(patch string) Edit {
	var e Edit
	for _, l := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(l, "***"), strings.HasPrefix(l, "+++"), strings.HasPrefix(l, "---"):
		case strings.HasPrefix(l, "+"):
			if strings.TrimSpace(l[1:]) != "" {
				e.add(l[1:])
			}
		case strings.HasPrefix(l, "-"):
			if strings.TrimSpace(l[1:]) != "" {
				e.Removed++
			}
		}
	}
	return e
}

// findPatch returns the first apply_patch patch in a tool call's input, which
// is either the patch itself or JSON arguments holding it somewhere, such as
// {"command":["apply_patch","*** Begin Patch..."]} or {"input":"*** Begin Patch..."}.
func findPatch(raw string) (string, bool) {
	if i := strings.Index(raw, "*** Begin Patch"); i >= 0 && !strings.HasPrefix(strings.TrimSpace(raw), "{") {
		return raw[i:], true
	}
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return "", false
	}
	var walk func(any) (string, bool)
	walk = func(v any) (string, bool) {
		switch x := v.(type) {
		case string:
			if i := strings.Index(x, "*** Begin Patch"); i >= 0 {
				return x[i:], true
			}
		case []any:
			for _, y := range x {
				if s, ok := walk(y); ok {
					return s, true
				}
			}
		case map[string]any:
			for _, y := range x {
				if s, ok := walk(y); ok {
					return s, true
				}
			}
		}
		return "", false
	}
	return walk(v)
}
