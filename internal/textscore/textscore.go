// Package textscore estimates how much of a prompt is real writing rather
// than keyboard mashing, without keeping the text.
//
// A word counts as real when it is an English dictionary word, looks like
// code (identifiers, paths, numbers, acronyms), or appears in the project's
// own files. Words in non-Latin scripts are not judged.
package textscore

import (
	"bufio"
	"bytes"
	"compress/gzip"
	_ "embed"
	"strings"
	"sync"
	"unicode"
)

// words.txt.gz is SCOWL's American English list (Debian wamerican), lowercased,
// without possessives. See WORDS-LICENSE.
//
//go:embed words.txt.gz
var wordsGz []byte

var dict = sync.OnceValue(func() map[string]struct{} {
	zr, err := gzip.NewReader(bytes.NewReader(wordsGz))
	if err != nil {
		panic(err)
	}
	m := make(map[string]struct{}, 80000)
	sc := bufio.NewScanner(zr)
	for sc.Scan() {
		m[sc.Text()] = struct{}{}
	}
	return m
})

// Score summarizes one prompt.
type Score struct {
	Judged  int      // words the checks could judge
	Real    int      // judged words that are dictionary words or code
	Unknown []string // the other judged words, lowercased, to check against a project's vocabulary
}

// Analyze scores text. The text itself is not retained, only unknown words.
func Analyze(text string) Score {
	var s Score
	for _, f := range strings.Fields(text) {
		w := strings.TrimFunc(f, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
		if w == "" || !latin(w) {
			continue
		}
		s.Judged++
		if realWord(w) {
			s.Real++
		} else {
			s.Unknown = append(s.Unknown, strings.ToLower(w))
		}
	}
	return s
}

// Noise returns the share of judged words that are neither real words nor in
// vocab: 0 for ordinary writing, 1 for pure gibberish, 0 when nothing was judged.
func (s Score) Noise(vocab Vocab) float64 {
	if s.Judged == 0 {
		return 0
	}
	real := s.Real
	for _, u := range s.Unknown {
		if _, ok := vocab[u]; ok {
			real++
		}
	}
	return float64(s.Judged-real) / float64(s.Judged)
}

func realWord(w string) bool {
	if strings.Contains(w, "-") && !strings.ContainsAny(w, "/\\._") {
		for _, p := range strings.Split(w, "-") {
			if p != "" && !realWord(p) {
				return false
			}
		}
		return true
	}
	return codeLike(w) || inDict(w)
}

func inDict(w string) bool {
	w = strings.ToLower(w)
	if i := strings.IndexAny(w, "'’"); i > 0 {
		w = w[:i] // don't -> don, it's -> it
	}
	if _, ok := dict()[w]; ok {
		return true
	}
	_, ok := extra[w]
	return ok
}

// extra holds chat shorthand and tech names that prompts use but the dictionary lacks.
var extra = func() map[string]struct{} {
	m := map[string]struct{}{}
	for _, w := range strings.Fields(`lgtm pls plz thx ty tysm ok okay idk btw imo imho wdym nvm rn tbh asap fyi
		yep yup nope hmm ui ux api apis cli gui ide repo repos config configs env dev prod staging localhost
		frontend backend fullstack async regex auth oauth jwt url urls json yaml toml csv html css sql nosql
		npm pnpm npx pip cargo github gitlab vercel netlify supabase firebase tailwind nextjs nodejs react
		svelte sveltekit vite webpack typescript javascript golang kotlin swiftui docker kubernetes postgres
		sqlite redis mongodb graphql websocket websockets readme todo todos linter eslint prettier pytest
		macos ios ipados android linux ubuntu wifi gpu cpu ram ssd http https ssh dns cdn llm llms gpt claude
		codex copilot cursor ai multiplayer netcode shader shaders sprite sprites hitbox fps lerp`) {
		m[w] = struct{}{}
	}
	return m
}()

// codeLike reports identifiers, paths, numbers, and short acronyms.
func codeLike(w string) bool {
	if strings.ContainsAny(w, "0123456789_./\\:=<>()[]{}#@$&|~`*+") {
		return true
	}
	upper := 0
	for i, r := range w {
		if unicode.IsUpper(r) {
			upper++
			if i > 0 && unicode.IsLower(rune(w[i-1])) {
				return true // camelCase
			}
		}
	}
	return upper == len(w) && len(w) >= 2 && len(w) <= 5 // API, CSS, HTTP
}

func latin(w string) bool {
	for _, r := range w {
		if r > unicode.MaxASCII && r != '’' {
			return false
		}
	}
	return true
}
