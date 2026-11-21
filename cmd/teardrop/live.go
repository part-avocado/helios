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

const (
	// liveSlack is how much older than the window a transcript's last write
	// may be and still be read, in case a clock was off when it was written.
	liveSlack = 24 * time.Hour
	// lookupLife is how long live mode trusts what it learned from git and
	// project files before asking again.
	lookupLife = time.Minute
	// A refresh that takes long waits liveRest times as long before the next
	// one, so live mode never keeps a processor busy on years of logs.
	liveRest = 4
)

// runLive redraws the timeline about every interval until interrupted.
func runLive(claudeDir, codexDir, since string, window time.Duration, rules timeline.Rules, every time.Duration) {
	every = max(every, time.Second)
	quietProgress = true // the bar would be drawn over the live screen
	_, _, tty := console(os.Stdout)
	if tty {
		// Draw on the alternate screen, like top does, so the scrollback is
		// left alone. Hide the cursor and cut long lines off instead of wrapping.
		fmt.Print("\033[?1049h\033[?25l\033[?7l\033[2J")
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	var look *lookups
	var lookRead time.Time
	for {
		began := time.Now()
		if look == nil || began.Sub(lookRead) > lookupLife {
			look, lookRead = newLookups(localProjects()), began
		}
		status, report := liveFrame(look, claudeDir, codexDir, since, began.Add(-window), rules)
		wait := max(every, liveRest*time.Since(began)).Round(time.Second)
		head := fmt.Sprintf("teardrop live · last %s · updated %s · every %s · Ctrl-C to quit", since, began.Format("15:04:05"), wait)
		lines := append(append([]string{head}, status...), "")
		if tty {
			cols, rows, _ := console(os.Stdout) // asked every time, so resizing the window works
			fmt.Print("\033[H" + strings.Join(fit(lines, report, cols, rows), "\033[K\n") + "\033[K\033[J")
		} else {
			fmt.Println(strings.Join(append(lines, report...), "\n") + "\n")
		}
		select {
		case <-time.After(wait):
		case <-stop:
			if tty {
				// Back on the normal screen, leave the last report behind.
				fmt.Print("\033[?7h\033[?25h\033[?1049l")
				fmt.Println(strings.Join(report, "\n"))
			}
			return
		}
	}
}

// liveFrame reads the logs and returns live mode's status lines and the
// report's lines.
func liveFrame(look *lookups, claudeDir, codexDir, since string, cutoff time.Time, rules timeline.Rules) (status, report []string) {
	now := time.Now()
	raws, warnings := loadSince(claudeDir, codexDir, cutoff.Add(-liveSlack))
	rep, sessions := buildReportWith(look, raws, cutoff, rules)

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
		status = append(status, fmt.Sprintf("%s in %s, last activity %s", state, project, when))
	}
	if len(warnings) > 0 {
		status = append(status, fmt.Sprintf("skipped %s that could not be read (teardrop -verbose lists them)", plural(len(warnings), "log file")))
	}
	var b bytes.Buffer
	if len(rep.Blocks) == 0 {
		printEmpty(&b, since, len(raws) > 0)
	} else {
		printReport(&b, rep, len(sessions))
	}
	return status, strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
}

// fit returns the lines to draw on a screen of cols by rows: head, then
// report. A report too tall for the screen keeps its first line (the column
// names) and its end, which holds the newest work and the totals. Lines too
// wide are cut off.
func fit(head, report []string, cols, rows int) []string {
	lines := append(append([]string{}, head...), report...)
	if room := rows - len(head); rows > 0 && len(lines) > rows && room >= 3 {
		hidden := len(report) - (room - 1)
		lines = append(append([]string{}, head...), report[0],
			fmt.Sprintf("  … %s hidden; make the window taller or use a shorter -since", plural(hidden, "older line")))
		lines = append(lines, report[len(report)-(room-2):]...)
	} else if rows > 0 && len(lines) > rows {
		lines = lines[:rows]
	}
	if cols > 0 {
		for i, l := range lines {
			if r := []rune(l); len(r) > cols {
				lines[i] = string(r[:cols])
			}
		}
	}
	return lines
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
