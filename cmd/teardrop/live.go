package main

import (
	"bytes"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// runLive redraws the timeline every interval until interrupted.
func runLive(claudeDir, codexDir, since string, window time.Duration, rules timeline.Rules, every time.Duration) {
	if every < time.Second {
		every = time.Second
	}
	tty := isTerminal(os.Stdout) && enableANSI()
	if tty {
		fmt.Print("\033[?25l\033[2J") // hide the cursor, clear the screen
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		frame := liveFrame(claudeDir, codexDir, since, window, rules, every)
		if tty {
			// Overwrite in place instead of clearing first, so the screen doesn't flicker.
			frame = strings.ReplaceAll(frame, "\n", "\033[K\n")
			fmt.Print("\033[H" + frame + "\033[J")
		} else {
			fmt.Print(frame + "\n")
		}
		select {
		case <-tick.C:
		case <-stop:
			if tty {
				fmt.Print("\033[?25h") // show the cursor again
			}
			fmt.Println()
			return
		}
	}
}

// liveFrame renders one screen of live mode.
func liveFrame(claudeDir, codexDir, since string, window time.Duration, rules timeline.Rules, every time.Duration) string {
	now := time.Now()
	raws, warnings := loadAll(claudeDir, codexDir)
	rep, sessions := buildReport(raws, now.Add(-window), rules)

	var b bytes.Buffer
	fmt.Fprintf(&b, "teardrop live · last %s · updated %s · every %s · Ctrl-C to quit\n", since, now.Format("15:04:05"), every)
	if last, project := lastActivity(sessions); !last.IsZero() {
		ago := now.Sub(last)
		state := "idle"
		if ago < rules.WatchCap {
			state = "active"
		}
		when := dur(ago) + " ago"
		if ago < time.Minute {
			when = "just now"
		}
		fmt.Fprintf(&b, "%s in %s, last activity %s\n", state, project, when)
	}
	if len(warnings) > 0 {
		fmt.Fprintf(&b, "skipped %s that could not be read (teardrop -verbose lists them)\n", plural(len(warnings), "log file"))
	}
	b.WriteString("\n")
	if len(rep.Blocks) == 0 {
		printEmpty(&b, since, len(raws) > 0)
	} else {
		printReport(&b, rep, len(sessions))
	}
	return b.String()
}

// lastActivity returns the newest event and its project.
func lastActivity(sessions []timeline.Session) (time.Time, string) {
	var last time.Time
	var project string
	for _, s := range sessions {
		for _, e := range s.Events {
			if e.Time.After(last) {
				last, project = e.Time, s.Project.Name
			}
		}
	}
	return last, project
}

func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}
