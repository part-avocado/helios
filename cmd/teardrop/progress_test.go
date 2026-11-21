package main

import (
	"strings"
	"testing"
)

func TestRenderBar(t *testing.T) {
	line := renderBar("Reading logs", 50, 200, "files", 80)
	if want := "25%  50/200 files"; !strings.HasSuffix(line, want) {
		t.Errorf("got %q, want it to end with %q", line, want)
	}
	if full, empty := strings.Count(line, "█"), strings.Count(line, "░"); full != 7 || empty != 23 {
		t.Errorf("a quarter done drew %d full and %d empty cells, want 7 and 23 of 30", full, empty)
	}
	// Never wider than the terminal, which would wrap and break redrawing.
	for cols := 12; cols <= 120; cols++ {
		if n := len([]rune(renderBar("Uploading", 7, 9, "bytes", cols))); n > cols-1 {
			t.Fatalf("%d columns: drew %d characters", cols, n)
		}
	}
	// A count past the total or below zero stays on the bar.
	if got := renderBar("x", 15, 10, "files", 80); !strings.Contains(got, "100%") {
		t.Errorf("overshoot: %q", got)
	}
	if got := renderBar("x", -3, 10, "files", 80); !strings.Contains(got, "  0%") {
		t.Errorf("negative: %q", got)
	}
}
