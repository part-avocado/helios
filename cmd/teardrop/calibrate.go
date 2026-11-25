package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"text/tabwriter"
	"time"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// runCalibrate shows how the time model's caps treat this person's own
// logs: how long the gaps before prompts and agent output are, and what the
// engaged total would be under other caps. Nothing is uploaded.
func runCalibrate(args []string) {
	fs := flag.NewFlagSet("calibrate", flag.ExitOnError)
	since := fs.String("since", "30d", "only read events newer than this")
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	fs.Parse(args)
	window, err := parseSince(*since)
	check(err)
	raws, _ := loadAll(*claudeDir, *codexDir)
	_, sessions := buildReport(raws, time.Now().Add(-window), timeline.DefaultRules)
	calibrate(os.Stdout, sessions)
}

// calibrate prints the gap distributions and the grid of totals for sessions.
func calibrate(out io.Writer, sessions []timeline.Session) {
	var compose, watch []time.Duration
	for _, s := range sessions {
		ev := slices.Clone(s.Events)
		slices.SortStableFunc(ev, func(a, b timeline.Event) int { return a.Time.Compare(b.Time) })
		human := false
		for i := 1; i < len(ev); i++ {
			gap := ev[i].Time.Sub(ev[i-1].Time)
			switch {
			case ev[i].Kind == timeline.Human:
				compose = append(compose, gap)
			case human:
				watch = append(watch, gap)
			}
			human = human || ev[i-1].Kind == timeline.Human
		}
	}
	fmt.Fprintf(out, "%s. Nothing was uploaded.\n\n", plural(len(sessions), "session"))
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', tabwriter.AlignRight)
	fmt.Fprintln(w, "Gap before\tcount\tmedian\t75%\t90%\tover cap\t")
	for _, row := range []struct {
		name string
		gaps []time.Duration
		cap  time.Duration
	}{{"a prompt", compose, timeline.DefaultRules.ComposeCap}, {"agent output", watch, timeline.DefaultRules.WatchCap}} {
		slices.Sort(row.gaps)
		over := 0
		for _, g := range row.gaps {
			if g > row.cap {
				over++
			}
		}
		fmt.Fprintf(w, "%s\t%d\t%s\t%s\t%s\t%s\t\n", row.name, len(row.gaps), pct(row.gaps, 50), pct(row.gaps, 75), pct(row.gaps, 90), share(over, len(row.gaps)))
	}
	w.Flush()
	fmt.Fprintln(out, "\nEngaged total by compose cap (rows) and watch cap (columns); * marks the caps in use:")
	w = tabwriter.NewWriter(out, 0, 0, 2, ' ', tabwriter.AlignRight)
	watches := []time.Duration{3 * time.Minute, 5 * time.Minute, 8 * time.Minute, 10 * time.Minute}
	fmt.Fprint(w, "\t")
	for _, wc := range watches {
		fmt.Fprintf(w, "%s\t", capName(wc, wc == timeline.DefaultRules.WatchCap))
	}
	fmt.Fprintln(w)
	for _, cc := range []time.Duration{2 * time.Minute, 3 * time.Minute, 5 * time.Minute, 8 * time.Minute, 10 * time.Minute} {
		fmt.Fprintf(w, "%s\t", capName(cc, cc == timeline.DefaultRules.ComposeCap))
		for _, wc := range watches {
			r := timeline.DefaultRules
			r.ComposeCap, r.WatchCap = cc, wc
			fmt.Fprintf(w, "%s\t", dur(timeline.Total(timeline.Engaged(sessions, r))))
		}
		fmt.Fprintln(w)
	}
	w.Flush()
}

func capName(d time.Duration, inUse bool) string {
	s := fmt.Sprintf("%dm", int(d.Minutes()))
	if inUse {
		s += "*"
	}
	return s
}

func pct(sorted []time.Duration, p int) string {
	if len(sorted) == 0 {
		return "-"
	}
	return dur(sorted[(len(sorted)-1)*p/100].Round(time.Second))
}

func share(n, of int) string {
	if of == 0 {
		return "-"
	}
	return fmt.Sprintf("%d%%", n*100/of)
}
