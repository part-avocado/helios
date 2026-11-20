package textscore

import (
	"bytes"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode"
)

// Vocab is the set of lowercased identifiers found in a project's files.
type Vocab map[string]struct{}

// Limits keep vocabulary building fast on old laptops and huge repositories.
const (
	maxFiles     = 5000
	maxFileBytes = 1 << 20
	maxTotal     = 32 << 20
)

// RepoVocab collects identifiers and their camelCase and snake_case parts from
// the text files under root: the files git tracks, or a plain walk outside git.
func RepoVocab(root string) Vocab {
	v := Vocab{}
	if root == "" {
		return v
	}
	total := 0
	for _, path := range listFiles(root) {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxFileBytes {
			continue
		}
		b, err := os.ReadFile(path)
		if err != nil || bytes.IndexByte(b[:min(len(b), 512)], 0) >= 0 {
			continue // unreadable or binary
		}
		v.add(filepath.Base(path))
		v.add(string(b))
		if total += len(b); total > maxTotal {
			break
		}
	}
	return v
}

func listFiles(root string) []string {
	var out []string
	if b, err := exec.Command("git", "-C", root, "ls-files", "-z").Output(); err == nil {
		for _, p := range strings.Split(string(b), "\x00") {
			if p != "" && len(out) < maxFiles {
				out = append(out, filepath.Join(root, p))
			}
		}
		return out
	}
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || len(out) >= maxFiles {
			return filepath.SkipDir
		}
		name := d.Name()
		if d.IsDir() && path != root && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor") {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			out = append(out, path)
		}
		return nil
	})
	return out
}

// add records every identifier in s, plus its parts: PlayerController adds
// playercontroller, player, and controller.
func (v Vocab) add(s string) {
	for _, id := range strings.FieldsFunc(s, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' }) {
		v.put(id)
		start := 0
		for i, r := range id {
			if r == '_' || (i > 0 && unicode.IsUpper(r) && unicode.IsLower(rune(id[i-1]))) {
				v.put(id[start:i])
				start = i
			}
		}
		v.put(id[start:])
	}
}

func (v Vocab) put(w string) {
	w = strings.Trim(strings.ToLower(w), "_")
	if len(w) >= 3 {
		v[w] = struct{}{}
	}
}
