package main

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

// A report taller than the screen is cut to fit, keeping the header, the
// column names, and the newest lines; otherwise every refresh would scroll
// the terminal.
func TestFit(t *testing.T) {
	head := []string{"teardrop live", "active in app", ""}
	var report []string
	for i := range 30 {
		report = append(report, fmt.Sprintf("row %02d", i))
	}
	got := fit(head, report, 80, 10)
	want := []string{"teardrop live", "active in app", "", "row 00", "", "row 25", "row 26", "row 27", "row 28", "row 29"}
	if len(got) != 10 || !strings.Contains(got[4], "24 older lines hidden") {
		t.Fatalf("got %d lines: %q", len(got), got)
	}
	got[4] = ""
	if !slices.Equal(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}

	// A report that fits is drawn whole, and wide lines are cut at the edge.
	if got := fit(head, []string{"a wide line of text", "é is one column"}, 8, 10); !slices.Equal(got[3:], []string{"a wide l", "é is one"}) || len(got) != 5 {
		t.Errorf("short report: %q", got)
	}
	// An unknown screen size (0) leaves everything as it is.
	if got := fit(head, report, 0, 0); len(got) != 33 {
		t.Errorf("unknown size: %d lines, want 33", len(got))
	}
}
