package textscore

import (
	_ "embed"
	"strings"
)

// letterpairs.bin says how likely each letter is to follow another in
// English and 30 other Latin-script languages, as people type them without
// accents. scripts/letter-pairs.py builds it from the most common words of
// each language: one table per language of 27 rows (word start, a to z) by
// 27 columns (a to z, word end), each byte -log(probability) times 16.
//
//go:embed letterpairs.bin
var letterPairs []byte

const pairTable = 27 * 27

// mashLimit is the average -log(probability) per letter pair, times 16,
// above which a word is unlike every language: -2.8 per pair. Real prompts
// in 14 languages in testdata/real.txt stay under it, and most keyboard
// mash in testdata/mash.txt goes over.
const mashLimit = 2.8 * 16

// mashed reports whether w, a word that is not in the dictionary and does
// not look like code, looks typed at random rather than written in some
// language. Pronounceable nonsense passes, as pasted text already does.
func mashed(w string) bool {
	w = strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 'a' - 'A'
		}
		if r >= 'a' && r <= 'z' {
			return r
		}
		return -1
	}, w)
	if w == "" {
		return false
	}
	if len(w) >= 3 && !strings.ContainsAny(w, "aeiouy") {
		return true // fkjx, dls
	}
	if repeats(w) {
		return true // aaaa, kakakaka, hjkhjkhjk
	}
	best := -1.0
	for t := 0; t+pairTable <= len(letterPairs); t += pairTable {
		sum, prev := 0, 0 // row 0 is the word's start
		for i := 0; i <= len(w); i++ {
			col := 26 // the word's end
			if i < len(w) {
				col = int(w[i] - 'a')
			}
			sum += int(letterPairs[t+prev*27+col])
			prev = col + 1
		}
		if avg := float64(sum) / float64(len(w)+1); best < 0 || avg < best {
			best = avg
		}
	}
	return best > mashLimit
}

// repeats reports a letter four times in a row, or a word that is one to
// three letters over and over, at least three times and six letters long.
func repeats(w string) bool {
	run := 1
	for i := 1; i < len(w); i++ {
		if w[i] == w[i-1] {
			if run++; run >= 4 {
				return true
			}
		} else {
			run = 1
		}
	}
	for p := 1; p <= 3; p++ {
		if len(w) < max(6, 3*p) {
			continue
		}
		periodic := true
		for i := p; i < len(w) && periodic; i++ {
			periodic = w[i] == w[i-p]
		}
		if periodic {
			return true
		}
	}
	return false
}
