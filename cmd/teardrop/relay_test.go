package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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

func TestPullRelayed(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEARDROP_DATA_DIR", dir)
	line := func(ev sources.JournalEvent) string {
		b, _ := json.Marshal(ev)
		return string(b)
	}
	at := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	prompt := sources.JournalEvent{Time: at, Tool: "amp", Event: "agent.start", Human: true, Session: "T-1", Cwd: "/home/user/workspace/repo", Git: "github.com/o/app", Judged: 4, Real: 4}
	pages := map[string][]string{
		"0": {
			line(prompt),
			line(prompt), // handed over twice
			line(sources.JournalEvent{Time: at, Tool: "claude-code", Event: "UserPromptSubmit", Human: true, Session: "c"}),
			line(sources.JournalEvent{Time: at.Add(48 * time.Hour), Tool: "amp", Event: "agent.start", Human: true, Session: "T-future"}),
			"not json",
		},
		"7": {line(sources.JournalEvent{Time: at.Add(time.Minute), Tool: "amp", Event: "agent.end", Session: "T-1"})},
	}
	last := map[string]int{"0": 7, "7": 9, "9": 9}
	var asked []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		who := r.Header.Get("Authorization")
		if (who != "Bearer mine" && who != "Bearer else") || !strings.HasPrefix(q.Get("computer"), "td-") {
			http.Error(w, "who are you?", http.StatusUnauthorized)
			return
		}
		asked = append(asked, q.Get("after"))
		json.NewEncoder(w).Encode(map[string]any{"last": last[q.Get("after")], "lines": pages[q.Get("after")]})
	}))
	defer ts.Close()

	// The repeat is written too; reading the journal is what drops it.
	n, err := pullRelayed(ts.Client(), ts.URL, "mine")
	if err != nil || n != 3 {
		t.Fatalf("took %d events (%v), want 3: only Amp's, and none from the future", n, err)
	}
	// Asking again past the last event is what tells the site it can forget them.
	if strings.Join(asked, ",") != "0,7,9" {
		t.Errorf("asked after %v, want 0, 7, then 9", asked)
	}
	raws, _ := sources.ReadJournal(dir)
	if len(raws) != 1 || raws[0].ID != "T-1" || raws[0].GitURL != "github.com/o/app" || len(raws[0].Events) != 2 {
		t.Fatalf("journal holds %+v, want T-1 with its repository and one prompt and one finish", raws)
	}

	// The next sync starts where this one stopped.
	asked = nil
	if n, err := pullRelayed(ts.Client(), ts.URL, "mine"); err != nil || n != 0 || strings.Join(asked, ",") != "9" {
		t.Errorf("a second pull took %d events after %v (%v), want none after 9", n, asked, err)
	}
	// Another account on the same site starts from its own beginning: the
	// site forgets what comes before the number asked for.
	asked = nil
	if _, err := pullRelayed(ts.Client(), ts.URL, "else"); err != nil || len(asked) == 0 || asked[0] != "0" {
		t.Errorf("another account's pull asked after %v (%v), want 0 first", asked, err)
	}

	// A site without cloud events, such as an older one, is not a failure.
	old := httptest.NewServer(http.NotFoundHandler())
	defer old.Close()
	if n, err := pullRelayed(old.Client(), old.URL, "mine"); err != nil || n != 0 {
		t.Errorf("a site without cloud events: took %d, err %v", n, err)
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
