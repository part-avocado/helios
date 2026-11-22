package timeline

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// TestSharedCases runs the cases the Worker's port of Credit runs too
// (worker/src/timeline.ts), so the two can't drift apart unnoticed.
func TestSharedCases(t *testing.T) {
	b, err := os.ReadFile("testdata/credit.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name    string           `json:"name"`
		Events  [][2]any `json:"events"`
		Engaged int64            `json:"engaged"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	for _, c := range cases {
		var ev []Event
		for _, e := range c.Events {
			s := int64(e[0].(float64))
			k := Agent
			if e[1] == "h" {
				k = Human
			}
			ev = append(ev, Event{Time: base.Add(time.Duration(s) * time.Second), Kind: k})
		}
		if got := Total(Credit(ev, DefaultRules)); got != time.Duration(c.Engaged)*time.Second {
			t.Errorf("%s: %v, want %ds", c.Name, got, c.Engaged)
		}
	}
}
