package textscore

import (
	_ "embed"
	"strings"
)

var letterPairs []byte

const pairTable = 27 * 27

const mashLimit = 2.8 * 16

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
		return true
	}
	if repeats(w) {
		return true
	}
	best := -1.0
	for t := 0; t+pairTable <= len(letterPairs); t += pairTable {
		sum, prev := 0, 0
		for i := 0; i <= len(w); i++ {
			col := 26
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
