package textscore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoise(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "net.go"), []byte("type RollbackNetcode struct{ tickRate, rttMs int }"), 0o644)
	vocab := RepoVocab(dir)

	for _, c := range []struct {
		text     string
		min, max float64
	}{
		{"fsdhfhfd fafkigsfak fkhaf fkjx", 1, 1},
		{"Hi, I would like for this portion to be more leftwards", 0, 0},
		{"don't touch the left-hand side", 0, 0},
		{"make RollbackNetcode use tickrate from src/net.go, see issue #12", 0, 0},
		{"fix the getUserById() call in the API", 0, 0},
		{"fkhaf-fkjx, qwzrt!", 1, 1},
		{"please fix fkjx qwzrt", 0.5, 0.5},
		{"请把这个按钮移到左边", 0, 0},
		{"puedes arreglar el boton de login que no funciona en el movil", 0, 0},
		{"zmien tlo na ciemnoniebieskie a tekst na bialy", 0, 0.5},
		{"asdfgh jkl", 1, 1},
		{"kakakaka jjjjjjj", 1, 1},
	} {
		if got := Analyze(c.text).Noise(vocab); got < c.min || got > c.max {
			t.Errorf("Noise(%q) = %.2f, want %.2f..%.2f", c.text, got, c.min, c.max)
		}
	}

	if got := Analyze("use rtt").Noise(nil); got != 0.5 {
		t.Errorf("without vocab: %.2f, want 0.50", got)
	}
	if got := Analyze("use rtt").Noise(vocab); got != 0 {
		t.Errorf("with vocab: %.2f, want 0", got)
	}
}

func TestNoiseCorpus(t *testing.T) {
	lines := func(name string) []string {
		b, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, l := range strings.Split(string(b), "\n") {
			if l != "" && !strings.HasPrefix(l, "#") {
				out = append(out, l)
			}
		}
		return out
	}
	langs := map[string]bool{}
	for _, l := range lines("real.txt") {
		lang, text, _ := strings.Cut(l, "\t")
		langs[lang] = true
		if n := Analyze(text).Noise(nil); n > 0.5 {
			t.Errorf("%s prompt scored as noise (%.2f): %s", lang, n, text)
		}
	}
	if len(langs) != 14 {
		t.Errorf("real.txt has %d languages, want 14", len(langs))
	}
	mash, passed := lines("mash.txt"), 0
	for _, text := range mash {
		if Analyze(text).Noise(nil) <= 0.5 {
			passed++
			t.Logf("mash passed: %s", text)
		}
	}
	if caught := 1 - float64(passed)/float64(len(mash)); caught < 0.93 {
		t.Errorf("caught %.0f%% of %d mash prompts, want at least 93%%", caught*100, len(mash))
	}
}

func TestWordlessPrompts(t *testing.T) {
	for _, text := range []string{".", "?", " ... ", "!?", "👍"} {
		if s := Analyze(text); !s.Low || s.Sim == 0 || s.Judged != 0 || s.Real != 0 {
			t.Errorf("Analyze(%q) = %+v, want a low-effort prompt with a fingerprint", text, s)
		}
	}
	if Analyze(".").Sim != Analyze("?!").Sim {
		t.Error("two wordless prompts should count as repeats of each other")
	}
	for _, text := range []string{"", "  \n\t"} {
		if s := Analyze(text); s.Low || s.Sim != 0 || s.Judged != 0 {
			t.Errorf("Analyze(%q) = %+v, want the zero score", text, s)
		}
	}
	if s := Analyze("add a login page with tests"); s.Low || s.Sim == 0 || s.Sim == 1 {
		t.Errorf("a real prompt scored %+v", s)
	}
}
