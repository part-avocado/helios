package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

func TestSendOutbox(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEARDROP_DATA_DIR", dir)
	at := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	queue := func(n int) {
		t.Helper()
		for i := 0; i < n; i++ {
			ev := sources.JournalEvent{Time: at.Add(time.Duration(i) * time.Second), Tool: "amp", Event: "agent.start", Human: true, Session: "T-1", Cwd: strings.Repeat("d", 300)}
			if err := queueRelay(ev); err != nil {
				t.Fatal(err)
			}
		}
	}
	var sent [][]byte
	answer := func(status int, err error) func([]byte) (int, error) {
		return func(lines []byte) (int, error) {
			sent = append(sent, bytes.Clone(lines))
			return status, err
		}
	}
	down := errors.New("server said 503")

	// What a site that is down didn't take goes out again on the next run.
	queue(2)
	if err := sendOutbox(dir, answer(503, down)); err == nil {
		t.Fatal("a failed upload was reported as sent")
	}
	queue(1)
	sent = nil
	if err := sendOutbox(dir, answer(200, nil)); err != nil {
		t.Fatal(err)
	}
	if n := bytes.Count(bytes.Join(sent, nil), []byte("\n")); n != 3 {
		t.Errorf("after a failed upload, the next run sent %d events, want all 3", n)
	}

	// A large outbox goes in several uploads, each of whole lines.
	queue(1000)
	sent = nil
	if err := sendOutbox(dir, answer(200, nil)); err != nil {
		t.Fatal(err)
	}
	if len(sent) < 2 {
		t.Errorf("%d upload for 1000 events, want several", len(sent))
	}
	for _, batch := range sent {
		if len(batch) > relayBatchBytes || !bytes.HasSuffix(batch, []byte("\n")) {
			t.Fatalf("an upload of %d bytes is too large or ends mid-line", len(batch))
		}
	}
	if n := bytes.Count(bytes.Join(sent, nil), []byte("\n")); n != 1000 {
		t.Errorf("sent %d events, want 1000", n)
	}

	// Events the site refuses for good are dropped, so they don't block later ones.
	queue(1)
	if err := sendOutbox(dir, answer(400, errors.New("server said 400"))); err != nil {
		t.Errorf("a refused upload stopped the outbox: %v", err)
	}
	sent = nil
	sendOutbox(dir, answer(200, nil))
	if len(sent) != 0 {
		t.Errorf("a refused upload was sent again: %q", sent)
	}
}

func TestHappenedAt(t *testing.T) {
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	for given, want := range map[string]time.Time{
		"2026-11-21T11:40:00.5Z":    time.Date(2026, 11, 21, 11, 40, 0, 500_000_000, time.UTC),
		"2026-11-21T06:40:00-05:00": now.Add(-20 * time.Minute),
		"2026-11-21T10:30:00Z":      now, // too long ago to trust
		"2026-11-21T12:30:00Z":      now, // not yet
		"":                          now,
	} {
		if got := happenedAt(now, given); !got.Equal(want) {
			t.Errorf("happenedAt(%q) = %v, want %v", given, got, want)
		}
	}
}
