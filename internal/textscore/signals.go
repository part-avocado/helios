package textscore

import (
	"hash/fnv"
	"math/bits"
	"strings"
	"unicode"
)

// Fingerprint is a 64-bit SimHash of a prompt's words and word pairs. Similar
// prompts get fingerprints that differ in few bits, so repeats can be found
// without keeping any text. It can't be turned back into the prompt.
type Fingerprint uint64

// Similar reports whether two fingerprints come from nearly the same prompt.
// Rewordings such as dropping "the" or changing punctuation land 0 to 7 bits
// apart; unrelated prompts land 20 or more apart.
func Similar(a, b Fingerprint) bool {
	return a != 0 && b != 0 && bits.OnesCount64(uint64(a^b)) <= 10
}

// lowEffort holds the words of prompts that steer without thinking:
// "continue", "yes do it", "fix it", "still not working".
var lowEffort = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`continue cont go on ahead proceed yes yeah yep yup y ok okay k sure
		do it that this again try keep going fix please pls plz still broken doesnt dont isnt not no work
		works working same error lgtm next more and the thanks thx ty good great nice cool now just
		run retry redo whatever anything fine`) {
		lowEffort[w] = true
	}
}

// signals fills in the fingerprint and low-effort flag of a scored prompt.
func (s *Score) signals(words []string) {
	if len(words) == 0 {
		return
	}
	var v [64]int
	add := func(f string) {
		h := fnv.New64a()
		h.Write([]byte(f))
		x := mix(h.Sum64())
		for i := range v {
			if x>>i&1 == 1 {
				v[i]++
			} else {
				v[i]--
			}
		}
	}
	low := len(words) <= 6
	words = expand(words)
	for i, w := range words {
		add(w)
		if i > 0 {
			add(words[i-1] + " " + w)
		}
		low = low && lowEffort[w]
	}
	for i, n := range v {
		if n > 0 {
			s.Sim |= 1 << i
		}
	}
	if s.Sim == 0 {
		s.Sim = 1 // 0 means "no fingerprint"
	}
	s.Low = low
}

// contractions maps "doesnt" to "does not" and similar, so a rewording that
// only contracts a word still fingerprints as the same request.
var contractions = map[string]string{
	"doesnt": "does not", "dont": "do not", "didnt": "did not", "isnt": "is not", "arent": "are not",
	"wasnt": "was not", "cant": "can not", "cannot": "can not", "wont": "will not", "its": "it is",
}

func expand(words []string) []string {
	var out []string
	for _, w := range words {
		if e, ok := contractions[w]; ok {
			out = append(out, strings.Fields(e)...)
		} else {
			out = append(out, w)
		}
	}
	return out
}

// mix spreads FNV's bits (splitmix64 finalizer), so each bit of a feature's
// hash is close to a fair coin.
func mix(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	return x ^ x>>31
}

// normalize lowercases a word and drops apostrophes, so "Doesn't" matches "doesnt".
func normalize(w string) string {
	return strings.Map(func(r rune) rune {
		if r == '\'' || r == '’' {
			return -1
		}
		return unicode.ToLower(r)
	}, w)
}
