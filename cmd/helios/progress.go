package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// A progressBar shows how far along a slow step is, on standard error, so it never
// mixes into what a command prints on standard output (-json, a pipe). It
// draws only on a terminal, and only for steps that run long enough to
// notice: a command that finishes in a blink prints nothing.
type progressBar struct {
	label  string
	total  int64
	unit   string // "files", or "bytes" for sizes shown as MB
	began  time.Time
	drawn  time.Time
	width  int // characters on screen at the last draw
	shown  bool
	enable bool
	out    io.Writer
}

// quietProgress turns every bar off. Live mode and the dashboard server set
// it: they run the same steps over and over, and live mode owns the screen.
var quietProgress bool

// A progressBar waits this long before its first draw, and draws at most this often.
const (
	barDelay    = 300 * time.Millisecond
	barInterval = 60 * time.Millisecond
)

// newBar starts a progressBar for total units of work. It draws nothing when
// standard error isn't a terminal, when the terminal can't redraw a line
// (TERM=dumb), or when total is unknown.
func newBar(label string, total int64, unit string) *progressBar {
	_, _, tty := console(os.Stderr)
	return &progressBar{label: label, total: total, unit: unit, began: time.Now(), out: os.Stderr,
		enable: tty && total > 0 && !quietProgress && os.Getenv("TERM") != "dumb"}
}

// set records that n units are done.
func (b *progressBar) set(n int64) {
	if !b.enable || time.Since(b.began) < barDelay {
		return
	}
	if now := time.Now(); n < b.total && now.Sub(b.drawn) < barInterval {
		return
	}
	b.drawn = time.Now()
	cols, _, _ := console(os.Stderr)
	line := renderBar(b.label, n, b.total, b.unit, cols)
	pad := ""
	if extra := b.width - len([]rune(line)); extra > 0 {
		pad = strings.Repeat(" ", extra) // wipe what the longer last line left behind
	}
	fmt.Fprint(b.out, "\r"+line+pad)
	b.width, b.shown = len([]rune(line)), true
}

// done erases the bar, so the command's own output starts on a clean line.
func (b *progressBar) done() {
	if b.shown {
		fmt.Fprint(b.out, "\r"+strings.Repeat(" ", b.width)+"\r")
		b.shown = false
	}
}

// renderBar draws one line that fits cols characters (80 when unknown), such
// as "Reading logs  [██████████░░░░░░░░░░]  50%  65/131 files".
func renderBar(label string, done, total int64, unit string, cols int) string {
	if cols <= 0 {
		cols = 80
	}
	done = max(0, min(done, total))
	pct := 0
	if total > 0 {
		pct = int(done * 100 / total)
	}
	var count string
	if unit == "bytes" {
		count = fmt.Sprintf("%s/%s", megabytes(done), megabytes(total))
	} else {
		count = fmt.Sprintf("%d/%d %s", done, total, unit)
	}
	tail := fmt.Sprintf("%3d%%  %s", pct, count)
	room := cols - 1 - len([]rune(label)) - len([]rune(tail)) - 6 // the gaps and brackets
	if room < 10 {                                                // too narrow for a bar: just the numbers
		return fitLine(label+"  "+tail, cols-1)
	}
	room = min(room, 30)
	full := int(int64(room) * done / max(total, 1))
	return label + "  [" + strings.Repeat("█", full) + strings.Repeat("░", room-full) + "]  " + tail
}

func fitLine(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// megabytes formats a size such as 12.3 MB.
func megabytes(n int64) string {
	if n < 100_000 {
		return fmt.Sprintf(txtKilobytes, float64(n)/1e3)
	}
	return fmt.Sprintf(txtMegabytes, float64(n)/1e6)
}

// progressReader counts bytes read through it onto a bar.
type progressReader struct {
	r io.Reader
	n int64
	b *progressBar
}

func (p *progressReader) Read(buf []byte) (int, error) {
	n, err := p.r.Read(buf)
	p.n += int64(n)
	p.b.set(p.n)
	return n, err
}
