package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/timeline"
)

func TestCountCloud(t *testing.T) {
	t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
	const repo = "/home/user/workspace/repo" // every cloud thread runs in this folder, whatever its project
	now := time.Now().UTC().Truncate(time.Second)
	at := now.Add(-2 * time.Hour)
	// thread is one prompt and Amp finishing four minutes later, start minutes after at.
	thread := func(id string, start int, cwd, git string) []string {
		var out []string
		for _, ev := range []sources.JournalEvent{
			{Time: at.Add(time.Duration(start) * time.Minute), Tool: "amp", Event: "agent.start", Human: true, Session: id, Cwd: cwd, Git: git, Judged: 6, Real: 6, Sim: uint64(start + 1)},
			{Time: at.Add(time.Duration(start+4) * time.Minute), Tool: "amp", Event: "agent.end", Session: id, Cwd: cwd, Git: git},
		} {
			b, _ := json.Marshal(ev)
			out = append(out, string(b))
		}
		return out
	}
	// What the site keeps: every line has the number it arrived as.
	var kept []string
	seed := make([]byte, ed25519.SeedSize)
	seed[0] = 7
	var asked []string
	var uploads []SignedReport
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mine" && r.Header.Get("Authorization") != "Bearer else" {
			http.Error(w, "who are you?", http.StatusUnauthorized)
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /api/v1/cloud":
			asked = append(asked, r.URL.Query().Get("after"))
			after, _ := strconv.Atoi(r.URL.Query().Get("after"))
			// Two lines to an answer, so more than one answer is needed.
			lines := kept[min(after, len(kept)):min(after+2, len(kept))]
			json.NewEncoder(w).Encode(map[string]any{"key": base64.RawURLEncoding.EncodeToString(seed), "last": after + len(lines), "lines": lines})
		case "POST /api/v1/reports":
			var s SignedReport
			b, _ := io.ReadAll(r.Body)
			if json.Unmarshal(b, &s) != nil {
				http.Error(w, "not a report", http.StatusBadRequest)
				return
			}
			uploads = append(uploads, s)
			w.Write([]byte(`{"account":"td-x"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	count := func(key string) timeline.Report {
		t.Helper()
		before := len(uploads)
		if err := countCloud(ts.Client(), ts.URL, key, now); err != nil {
			t.Fatal(err)
		}
		if len(uploads) != before+1 {
			t.Fatalf("%d reports uploaded, want one", len(uploads)-before)
		}
		var p exportPayload
		if err := json.Unmarshal([]byte(uploads[before].Payload), &p); err != nil {
			t.Fatal(err)
		}
		return p.Report
	}

	// One thread alone says how much one prompt and its four minutes earn.
	kept = thread("T-1", 0, repo, "git@github.com:Kid/Site.git")
	alone := count("mine")
	if alone.Engaged <= 0 || len(alone.Projects) != 1 {
		t.Fatalf("one thread: %d engaged seconds in %d projects, want some in one", alone.Engaged, len(alone.Projects))
	}
	// The project is the repository the events name, not the folder they share.
	if got := alone.Projects[0].Project; got.Key != "github.com/kid/site" || got.Name != "site" {
		t.Errorf("project %+v, want github.com/kid/site", got)
	}
	// Every thread signs as the computer whose key the site hands out.
	h, err := verifySigned(uploads[0], now)
	if want := base64.RawURLEncoding.EncodeToString(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)); err != nil || h.Account != want {
		t.Errorf("signed by %q (%v), want the site's cloud key %q", h.Account, err, want)
	}

	// A second thread at the very same minutes adds nothing: side by side counts once.
	// A third, later and in a folder without a repository, adds its own time.
	kept = append(kept, thread("T-2", 0, repo, "git@github.com:Kid/Site.git")...)
	asked = nil
	if both := count("mine"); both.Engaged != alone.Engaged {
		t.Errorf("two threads side by side: %d engaged seconds, want the %d of one", both.Engaged, alone.Engaged)
	}
	// Only what this machine lacks is asked for.
	if strings.Join(asked, ",") != "2,4" {
		t.Errorf("asked after %v, want 2, then 4 to find there is no more", asked)
	}
	kept = append(kept, thread("T-3", 30, "/home/user/workspace/notes", "")...)
	three := count("mine")
	if three.Engaged != 2*alone.Engaged {
		t.Errorf("a later thread: %d engaged seconds, want twice the %d of one", three.Engaged, alone.Engaged)
	}
	var keys []string
	for _, p := range three.Projects {
		keys = append(keys, p.Project.Key)
	}
	if strings.Join(keys, " ") != "github.com/kid/site /home/user/workspace/notes" && strings.Join(keys, " ") != "/home/user/workspace/notes github.com/kid/site" {
		t.Errorf("projects %q, want the repository and the folder without one", keys)
	}

	// Another account on this machine starts from nothing of the first's.
	kept = thread("T-9", 60, "/home/user/workspace/other", "")
	asked = nil
	if other := count("else"); other.Engaged != alone.Engaged || asked[0] != "0" {
		t.Errorf("another account: %d engaged seconds after asking from %v, want %d from 0", other.Engaged, asked, alone.Engaged)
	}

	// A server that can't hand out the key gets no report.
	seed = nil
	before := len(uploads)
	if err := countCloud(ts.Client(), ts.URL, "mine", now); err == nil || len(uploads) != before {
		t.Errorf("without a key from the server: err %v and %d uploads, want an error and none", err, len(uploads)-before)
	}
}
