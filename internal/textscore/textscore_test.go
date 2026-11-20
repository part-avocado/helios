package textscore

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNoise(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "net.go"), []byte("type RollbackNetcode struct{ tickRate int }"), 0o644)
	vocab := RepoVocab(dir)

	for _, c := range []struct {
		text     string
		min, max float64
	}{
		{"fsdhfhfd fafkigsfak fkhaf fkjx", 1, 1},
		{"Hi, I would like for this portion to be more leftwards", 0, 0},
		{"don't touch the left-hand side", 0, 0},
		// Code and project words are real even though no dictionary has them.
		{"make RollbackNetcode use tickrate from src/net.go, see issue #12", 0, 0},
		{"fix the getUserById() call in the API", 0, 0},
		// Gibberish dressed up with punctuation or hyphens still counts as gibberish.
		{"fkhaf-fkjx, qwzrt!", 1, 1},
		// Half real words, half mashing.
		{"please fix fkjx qwzrt", 0.5, 0.5},
		// Other scripts are not judged, so they are not penalized.
		{"请把这个按钮移到左边", 0, 0},
	} {
		if got := Analyze(c.text).Noise(vocab); got < c.min || got > c.max {
			t.Errorf("Noise(%q) = %.2f, want %.2f..%.2f", c.text, got, c.min, c.max)
		}
	}
	// Without the repo, the project word "tickrate" is unknown.
	if got := Analyze("use tickrate").Noise(nil); got != 0.5 {
		t.Errorf("without vocab: %.2f, want 0.50", got)
	}
}
