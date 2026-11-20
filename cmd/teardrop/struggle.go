package main

import (
	"github.com/part-avocado/teardrop/internal/textscore"
	"github.com/part-avocado/teardrop/internal/timeline"
)

const (
	// freePasses is how many repeats of a request, or low-effort prompts in
	// a row, still count. Saying "continue" twice, or asking again after the
	// agent's first try failed, is real work; the third time is going in circles.
	freePasses = 2
	// repeatWindow is how many earlier prompts in a session a prompt is compared to.
	repeatWindow = 5
)

// discount marks the prompts in one session's events that should earn no
// time: gibberish (by noisy), the third or later near-repeat of a request, and
// the third or later low-effort steering prompt in a row. A substantive prompt
// ends a low-effort run.
func discount(events []timeline.Event, scores map[int]textscore.Score, noisy func(timeline.Event, textscore.Score) bool) {
	var recent []textscore.Fingerprint
	lowRun := 0
	for i := range events {
		if events[i].Kind != timeline.Human {
			continue
		}
		s, ok := scores[i]
		if !ok || s.Sim == 0 {
			lowRun = 0 // an image or a prompt teardrop couldn't score counts normally
			continue
		}
		switch {
		case noisy(events[i], s):
			events[i].Kind = timeline.Noise
		case s.Low:
			if lowRun++; lowRun > freePasses {
				events[i].Kind = timeline.Autopilot
			}
		default:
			lowRun = 0
			seen := 0
			for _, h := range recent {
				if textscore.Similar(h, s.Sim) {
					seen++
				}
			}
			if seen >= freePasses {
				events[i].Kind = timeline.Repeat
			}
		}
		if recent = append(recent, s.Sim); len(recent) > repeatWindow {
			recent = recent[1:]
		}
	}
}
