package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/part-avocado/teardrop/internal/sources"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// A submission is accepted only with the logs behind every claimed block,
// and the server's recomputed hours match the client's.
func TestSubmission(t *testing.T) {
	home := t.TempDir()
	t.Setenv("TEARDROP_DATA_DIR", filepath.Join(home, "data"))
	claude := filepath.Join(home, "claude")
	dir := filepath.Join(claude, "projects", "app")
	os.MkdirAll(dir, 0o700)
	now := time.Now().UTC().Truncate(time.Second)
	at := func(m int) string { return now.Add(time.Duration(m-60) * time.Minute).Format(time.RFC3339) }
	var log strings.Builder
	prompts := []string{"add a login page with email and password", "make the button blue and center it", "now write tests for the login form"}
	for i, p := range prompts {
		log.WriteString(`{"type":"user","timestamp":"` + at(i*4) + `","cwd":"/nowhere/app","sessionId":"s1","message":{"content":"` + p + `"}}` + "\n")
		log.WriteString(`{"type":"assistant","timestamp":"` + at(i*4+2) + `","message":{"id":"m` + string(rune('0'+i)) + `","content":[{"type":"text","text":"ok"}]}}` + "\n")
	}
	os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(log.String()), 0o600)

	raws, _ := loadAll(claude, filepath.Join(home, "nocodex"))
	rep, sessions := buildReport(raws, now.Add(-24*time.Hour), timeline.DefaultRules)
	if len(rep.Projects) != 1 || rep.Engaged == 0 {
		t.Fatalf("no time found: %+v", rep)
	}
	key := rep.Projects[0].Project.Key
	sub, err := makeSubmission(key, rep, sessions, "1d", now)
	if err != nil {
		t.Fatal(err)
	}

	s := &server{dir: t.TempDir(), maxBody: 1 << 20, admins: map[string]bool{"UADMIN": true}, secret: []byte("0123456789abcdef0123456789abcdef"),
		client: http.DefaultClient}
	srv := httptest.NewServer(s.handler())
	defer srv.Close()
	send := func(s Submission) (int, string) {
		b, _ := json.Marshal(s)
		res, err := http.Post(srv.URL+"/api/v1/submissions", "application/json", bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var buf bytes.Buffer
		buf.ReadFrom(res.Body)
		return res.StatusCode, buf.String()
	}

	code, body := send(sub)
	var rec submissionRecord
	json.Unmarshal([]byte(body), &rec)
	if code != 200 || rec.Recomputed != rep.Engaged || rec.Claimed != rep.Engaged || rep.Engaged != timeline.Seconds(10*time.Minute) {
		t.Fatalf("honest submission: %d %s (client engaged %v)", code, body, rep.Engaged)
	}
	// Nothing else covers this time yet, so all of it is credited.
	if rec.EarlierOverlap != 0 || rec.Credited != rec.Recomputed {
		t.Errorf("first submission: already submitted %v, credited %v, want 0 and %v", time.Duration(rec.EarlierOverlap), time.Duration(rec.Credited), time.Duration(rec.Recomputed))
	}

	// Only admins see details: anonymous callers get 401, other Slack users 403.
	get := func(c *http.Client, path string) int {
		res, err := c.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if c := get(http.DefaultClient, "/api/v1/submissions/"+rec.ID); c != 401 {
		t.Errorf("anonymous read: %d", c)
	}
	signedIn := func(user string) *http.Client {
		jar, _ := cookiejar.New(nil)
		u, _ := url.Parse(srv.URL)
		jar.SetCookies(u, []*http.Cookie{{Name: sessionCookie, Value: s.sign(user + "|" + strconv.FormatInt(now.Add(time.Hour).Unix(), 10))}})
		return &http.Client{Jar: jar}
	}
	for _, path := range []string{"/api/v1/submissions/" + rec.ID, "/admin/submissions/" + rec.ID, "/api/v1/accounts/x/report"} {
		if c := get(signedIn("USOMEONE"), path); c != 403 {
			t.Errorf("non-admin %s: %d", path, c)
		}
	}
	if c := get(signedIn("UADMIN"), "/admin/submissions/"+rec.ID); c != 200 {
		t.Errorf("admin review page: %d", c)
	}
	// A forged cookie doesn't sign anyone in.
	forged := signedIn("UADMIN")
	u, _ := url.Parse(srv.URL)
	forged.Jar.SetCookies(u, []*http.Cookie{{Name: sessionCookie, Value: "UADMIN|9999999999.AAAA"}})
	if c := get(forged, "/api/v1/submissions/"+rec.ID); c != 401 {
		t.Errorf("forged cookie: %d", c)
	}

	// Editing a log after signing breaks its hash.
	edited := sub
	edited.Logs = [][]byte{bytes.Replace(sub.Logs[0], []byte("blue"), []byte("red!"), 1)}
	if code, body := send(edited); code != 400 || !strings.Contains(body, "not the one that was signed") {
		t.Errorf("edited log: %d %s", code, body)
	}

	// Leaving the logs out is refused.
	bare := sub
	bare.Logs = nil
	if code, _ := send(bare); code != 400 {
		t.Errorf("no logs: %d", code)
	}

	// A signed claim of a block that no log backs is refused.
	fluffed := rep
	fluffed.Blocks = append([]timeline.Block{{Project: rep.Projects[0].Project, Start: now.Add(-5 * time.Hour), End: now.Add(-3 * time.Hour), Engaged: timeline.Seconds(2 * time.Hour)}}, rep.Blocks...)
	fake, _ := makeSubmission(key, fluffed, sessions, "1d", now)
	if code, body := send(fake); code != 400 || !strings.Contains(body, "no log backs") {
		t.Errorf("unbacked block: %d %s", code, body)
	}

	// Sending the same submission again keeps its record.
	code, body = send(sub)
	var kept submissionRecord
	json.Unmarshal([]byte(body), &kept)
	if code != 200 || kept.ID != rec.ID || kept.Credited != rec.Credited || !kept.ReceivedAt.Equal(rec.ReceivedAt) {
		t.Errorf("same submission again: %d %s", code, body)
	}

	// A later submission that also covers the first one's time is credited
	// only for the new time.
	exchange := func(session string, minute int) string {
		return `{"type":"user","timestamp":"` + at(minute) + `","cwd":"/nowhere/app","sessionId":"` + session + `","message":{"content":"add a settings page with a dark mode toggle"}}` + "\n" +
			`{"type":"assistant","timestamp":"` + at(minute+10) + `","message":{"id":"` + session + `","content":[{"type":"text","text":"ok"}]}}` + "\n"
	}
	os.WriteFile(filepath.Join(dir, "s2.jsonl"), []byte(exchange("s2", 30)), 0o600)
	raws, _ = loadAll(claude, filepath.Join(home, "nocodex"))
	rep2, sessions2 := buildReport(raws, now.Add(-24*time.Hour), timeline.DefaultRules)
	sub2, _ := makeSubmission(key, rep2, sessions2, "1d", now.Add(time.Second))
	code, body = send(sub2)
	var rec2 submissionRecord
	json.Unmarshal([]byte(body), &rec2)
	if code != 200 || rec2.Recomputed != timeline.Seconds(20*time.Minute) || rec2.EarlierOverlap != timeline.Seconds(10*time.Minute) || rec2.Credited != timeline.Seconds(10*time.Minute) {
		t.Errorf("second submission: %d recomputed %v, already submitted %v, credited %v; want 20m, 10m, 10m",
			code, time.Duration(rec2.Recomputed), time.Duration(rec2.EarlierOverlap), time.Duration(rec2.Credited))
	}

	// Logs can't earn time after the signing time, even when no block claims it.
	os.WriteFile(filepath.Join(dir, "s3.jsonl"), []byte(exchange("s3", 180)), 0o600)
	raws, _ = loadAll(claude, filepath.Join(home, "nocodex"))
	rep3, sessions3 := buildReport(raws, now.Add(-24*time.Hour), timeline.DefaultRules)
	if len(rep3.Blocks) != 3 {
		t.Fatalf("want 3 blocks with the future one last, got %+v", rep3.Blocks)
	}
	rep3.Blocks = rep3.Blocks[:2]
	early, _ := makeSubmission(key, rep3, sessions3, "1d", now.Add(2*time.Second))
	if code, body := send(early); code != 400 || !strings.Contains(body, "logs have activity after") {
		t.Errorf("logs from the future: %d %s", code, body)
	}
}

// Signing in goes through Hack Club Auth and lands on the admin page.
func TestHCALogin(t *testing.T) {
	var srvURL string
	hca := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/authorize": // the person approves; Hack Club Auth sends them back
			q := r.URL.Query()
			if !strings.Contains(q.Get("scope"), "slack_id") {
				http.Error(w, "no slack_id scope", 400)
				return
			}
			http.Redirect(w, r, q.Get("redirect_uri")+"?code=c1&state="+q.Get("state"), http.StatusFound)
		case "/oauth/token":
			r.ParseForm()
			if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "c1" || r.Form.Get("client_secret") != "sec" || r.Form.Get("redirect_uri") != srvURL+"/auth/callback" {
				http.Error(w, `{"error":"invalid_grant"}`, 400)
				return
			}
			w.Write([]byte(`{"access_token":"at","token_type":"Bearer"}`))
		case "/oauth/userinfo":
			if r.Header.Get("Authorization") != "Bearer at" {
				http.Error(w, `{"error":"invalid_token"}`, 401)
				return
			}
			w.Write([]byte(`{"sub":"ident!x","slack_id":"UADMIN"}`))
		}
	}))
	defer hca.Close()
	s := &server{dir: t.TempDir(), admins: map[string]bool{"UADMIN": true}, secret: []byte("0123456789abcdef0123456789abcdef"), client: http.DefaultClient}
	srv := httptest.NewServer(s.handler())
	defer srv.Close()
	srvURL = srv.URL
	s.hca = hcaApp{base: hca.URL, clientID: "id", clientSecret: "sec", redirect: srv.URL + "/auth/callback"}

	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	res, err := c.Get(srv.URL + "/admin#accounts")
	if err != nil {
		t.Fatal(err)
	}
	var page bytes.Buffer
	page.ReadFrom(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || res.Request.URL.Path != "/admin" || !strings.Contains(page.String(), "Only time in the agent chat counts") {
		t.Fatalf("after sign-in: %d at %s", res.StatusCode, res.Request.URL)
	}
	// A callback whose state doesn't match the browser's is refused.
	res, _ = c.Get(srv.URL + "/auth/callback?code=c1&state=forged")
	if res.StatusCode != 400 {
		t.Errorf("forged state: %d", res.StatusCode)
	}
}

// makeSubmission signs project key's part of rep together with the logs of
// its sessions.
func makeSubmission(key string, rep timeline.Report, sessions []timeline.Session, since string, now time.Time) (Submission, error) {
	var mine timeline.Report
	for _, b := range rep.Blocks {
		if b.Project.Key == key {
			mine.Blocks = append(mine.Blocks, b)
		}
	}
	var project timeline.Project
	for _, p := range rep.Projects {
		if p.Project.Key == key {
			mine.Projects, mine.Engaged, project = []timeline.ProjectTotal{p}, p.Engaged, p.Project
		}
	}
	var sub Submission
	var logs []submittedLog
	seen := map[string]bool{}
	for _, s := range sessions {
		if s.Project.Key != key || seen[s.Path] {
			continue
		}
		seen[s.Path] = true
		tool := s.Tool
		var data []byte
		var err error
		if strings.Contains(s.Path, ".jsonl#") { // read from the hook journal, not a transcript
			tool, data = "journal", sources.JournalLines(dataDir(), s.Tool, s.ID)
		} else if data, err = sources.ReadLog(s.Path); err != nil {
			return sub, fmt.Errorf("reading %s: %w", s.Path, err)
		}
		sum := sha256.Sum256(data)
		logs = append(logs, submittedLog{Tool: tool, ID: s.ID, SHA256: hex.EncodeToString(sum[:])})
		sub.Logs = append(sub.Logs, data)
	}
	signed, err := signPayload(func(account string) any {
		return submissionPayload{
			Kind: "submission", Account: account,
			GeneratedAt: now.UTC(), ExpiresAt: now.UTC().Add(keyLifetime),
			Since: since, Teardrop: version, Project: project, Report: mine, Logs: logs,
		}
	})
	sub.Signed = signed
	return sub, err
}
