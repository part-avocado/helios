package main

import (
	"testing"
	"time"

	"github.com/part-avocado/helios/internal/textscore"
	"github.com/part-avocado/helios/internal/timeline"
)

// kinds runs discount over prompts (with an agent reply after each) and
// returns one letter per prompt: H counts, N noise, R repeat, A autopilot.
func kinds(prompts ...string) string {
	var ev []timeline.Event
	scores := map[int]textscore.Score{}
	t := time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC)
	for i, p := range prompts {
		scores[len(ev)] = textscore.Analyze(p)
		ev = append(ev, timeline.Event{Time: t.Add(time.Duration(i*2) * time.Minute), Kind: timeline.Human})
		ev = append(ev, timeline.Event{Time: t.Add(time.Duration(i*2+1) * time.Minute), Kind: timeline.Agent})
	}
	discount(ev, scores, func(_ timeline.Event, s textscore.Score) bool { return s.Noise(nil) > noiseThreshold })
	out := ""
	for _, e := range ev {
		out += map[timeline.Kind]string{timeline.Human: "H", timeline.Noise: "N", timeline.Repeat: "R", timeline.Autopilot: "A"}[e.Kind]
	}
	return out
}

func TestDiscount(t *testing.T) {
	for _, c := range []struct {
		name    string
		prompts []string
		want    string
	}{
		{"steering twice is fine, the third time is autopilot, a real prompt resets the run",
			[]string{"continue", "yes do it", "Still not working", "fix it", "add a test for the login redirect", "continue", "ok"}, "HHAAHHH"},
		{"asking again once is fine; the third rewording of the same request is a repeat",
			[]string{"the login button still does nothing when I click it", "Login button still does nothing when I click it!",
				"login button still does nothing when i click it"}, "HHR"},
		{"contracting a word doesn't hide a repeat",
			[]string{"the game still does not work", "the game still doesn't work!", "The game still does not work."}, "HHR"},
		{"different requests about the same feature are not repeats",
			[]string{"make the scoreboard more leftwards", "fix the scoreboard so it is more leftwards", "now align the scoreboard with the minimap"}, "HHH"},
		{"a repeat is forgotten after five other prompts",
			[]string{"rename the player class to Agent", "rename the player class to Agent", "add jumping", "add crouching",
				"add a pause menu", "add sound effects", "add a main menu", "rename the player class to Agent"}, "HHHHHHHH"},
		{"gibberish is noise and does not break an autopilot run",
			[]string{"continue", "continue", "fsdhfhfd fafkigsfak", "continue"}, "HHNA"},
	} {
		if got := kinds(c.prompts...); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}
