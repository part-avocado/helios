package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/timeline"
)

// ---- Sign in with Slack ----

// slackApp is a Slack app used for "Sign in with Slack" (OpenID Connect).
type slackApp struct {
	base, clientID, clientSecret, redirect string
}

const (
	sessionCookie = "teardrop_session"
	stateCookie   = "teardrop_state"
	sessionLife   = 7 * 24 * time.Hour
)

// sessionSecret loads the key that signs sign-in cookies, creating it once.
func sessionSecret(dir string) ([]byte, error) {
	path := filepath.Join(dir, "session.key")
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return b, nil
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, writeFile(path, b)
}

func (s *server) sign(v string) string {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(v))
	return v + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *server) unsign(c string) (string, bool) {
	i := strings.LastIndexByte(c, '.')
	if i < 0 || !hmac.Equal([]byte(s.sign(c[:i])), []byte(c)) {
		return "", false
	}
	return c[:i], true
}

func setCookie(w http.ResponseWriter, r *http.Request, name, value string, life time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/", MaxAge: int(life / time.Second),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, // Lax: other sites can't POST with it
		Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	})
}

// user returns the Slack user ID signed in on r, or "".
func (s *server) user(r *http.Request) string {
	if s.devLogin != "" {
		return s.devLogin
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	v, ok := s.unsign(c.Value)
	id, exp, _ := strings.Cut(v, "|")
	n, err := strconv.ParseInt(exp, 10, 64)
	if !ok || err != nil || time.Now().Unix() > n {
		return ""
	}
	return id
}

// admin lets only admins through to h. People who aren't signed in are sent
// to sign in; API callers get an error instead.
func (s *server) admin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := s.user(r)
		api := strings.HasPrefix(r.URL.Path, "/api/")
		switch {
		case id == "" && api:
			httpError(w, http.StatusUnauthorized, "admins only; sign in at /login")
		case id == "":
			http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		case !s.admins[id] && api:
			httpError(w, http.StatusForbidden, "admins only")
		case !s.admins[id]:
			s.render(w, http.StatusForbidden, "denied", map[string]any{"User": id})
		default:
			h(w, r)
		}
	}
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	next := r.URL.Query().Get("next")
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") {
		next = "/admin"
	}
	if s.devLogin != "" {
		http.Redirect(w, r, next, http.StatusFound)
		return
	}
	if s.slack.clientID == "" {
		httpError(w, http.StatusServiceUnavailable, "Slack sign-in is not set up on this server")
		return
	}
	b := make([]byte, 16)
	rand.Read(b)
	state := base64.RawURLEncoding.EncodeToString(b)
	setCookie(w, r, stateCookie, s.sign(base64.RawURLEncoding.EncodeToString([]byte(state+"|"+next))), 10*time.Minute)
	q := url.Values{
		"response_type": {"code"}, "scope": {"openid"}, "client_id": {s.slack.clientID},
		"redirect_uri": {s.slack.redirect}, "state": {state},
	}
	http.Redirect(w, r, s.slack.base+"/openid/connect/authorize?"+q.Encode(), http.StatusFound)
}

func (s *server) slackCallback(w http.ResponseWriter, r *http.Request) {
	var state, next string
	if c, err := r.Cookie(stateCookie); err == nil {
		if v, ok := s.unsign(c.Value); ok {
			raw, _ := base64.RawURLEncoding.DecodeString(v)
			state, next, _ = strings.Cut(string(raw), "|")
		}
	}
	if state == "" || r.URL.Query().Get("state") != state {
		httpError(w, http.StatusBadRequest, "sign-in expired or came from somewhere else; try again at /login")
		return
	}
	setCookie(w, r, stateCookie, "", -1)
	id, err := s.slack.userID(s.client, r.URL.Query().Get("code"))
	if err != nil {
		log.Printf("Slack sign-in failed: %v", err)
		httpError(w, http.StatusBadGateway, "Slack sign-in failed: %v", err)
		return
	}
	exp := time.Now().Add(sessionLife).Unix()
	setCookie(w, r, sessionCookie, s.sign(id+"|"+strconv.FormatInt(exp, 10)), sessionLife)
	http.Redirect(w, r, next, http.StatusFound)
}

func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	setCookie(w, r, sessionCookie, "", -1)
	http.Redirect(w, r, "/", http.StatusFound)
}

// userID trades a sign-in code for the Slack user ID of who signed in.
func (a slackApp) userID(c *http.Client, code string) (string, error) {
	res, err := c.PostForm(a.base+"/api/openid.connect.token", url.Values{
		"client_id": {a.clientID}, "client_secret": {a.clientSecret}, "code": {code}, "redirect_uri": {a.redirect},
	})
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var tok struct {
		OK          bool   `json:"ok"`
		Error       string `json:"error"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&tok); err != nil {
		return "", err
	}
	if !tok.OK {
		return "", errors.New(tok.Error)
	}
	req, _ := http.NewRequest("GET", a.base+"/api/openid.connect.userInfo", nil)
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	res2, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer res2.Body.Close()
	var info struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Sub    string `json:"sub"`
		UserID string `json:"https://slack.com/user_id"`
	}
	if err := json.NewDecoder(res2.Body).Decode(&info); err != nil {
		return "", err
	}
	if !info.OK {
		return "", errors.New(info.Error)
	}
	if info.UserID != "" {
		return info.UserID, nil
	}
	if info.Sub == "" {
		return "", errors.New("Slack did not say who signed in")
	}
	return info.Sub, nil
}

// ---- Lapse and Lookout ----

// Lapse records through Lookout, which saves one capture a minute. A
// capture stands for the minute after it.
const lookoutCapture = time.Minute

// lapseCheck is one Lapse or Lookout session checked against a submission.
type lapseCheck struct {
	Token     string              `json:"token"`
	CheckedAt time.Time           `json:"checked_at"`
	Captured  []timeline.Interval `json:"captured"`
	Error     string              `json:"error,omitempty"`
}

var lookoutTokenRe = regexp.MustCompile(`[0-9a-fA-F]{64}`)

// lookoutToken finds a Lookout session token in a link or a bare token.
func lookoutToken(s string) string {
	return strings.ToLower(lookoutTokenRe.FindString(s))
}

func setLapse(list []lapseCheck, c lapseCheck) []lapseCheck {
	for i := range list {
		if list[i].Token == c.Token {
			list[i] = c
			return list
		}
	}
	return append(list, c)
}

// checkLapse reads when a Lookout session recorded, honoring its cuts.
func (s *server) checkLapse(tok string) lapseCheck {
	c := lapseCheck{Token: tok, CheckedAt: time.Now().UTC()}
	res, err := s.client.Get(s.lookout + "/api/sessions/" + tok + "/timings")
	if err != nil {
		c.Error = "could not reach Lookout"
		return c
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		c.Error = "Lookout has no session with this token"
		return c
	default:
		c.Error = "Lookout said " + res.Status
		return c
	}
	var t struct {
		Timestamps []time.Time `json:"timestamps"`
	}
	if json.NewDecoder(res.Body).Decode(&t) != nil {
		c.Error = "Lookout's reply was not understood"
		return c
	}
	for _, ts := range t.Timestamps {
		c.Captured = append(c.Captured, timeline.Interval{Start: ts, End: ts.Add(lookoutCapture)})
	}
	c.Captured = timeline.Union(c.Captured)
	if len(c.Captured) == 0 {
		c.Error = "no captures (recordings made before late May 2026 have no timestamps)"
	}
	return c
}

// deflate takes the time Lapse sessions also cover off the recomputed hours.
// Lapse time goes to Hackatime, so counting it here too would count it twice.
func (rec *submissionRecord) deflate() {
	overlap := timeline.Overlap(rec.Engaged, rec.lapseTime())
	rec.LapseOverlap = timeline.Seconds(overlap)
	rec.Credited = timeline.Seconds(max(0, time.Duration(rec.Recomputed)-overlap))
}

func (rec submissionRecord) lapseTime() []timeline.Interval {
	var all []timeline.Interval
	for _, c := range rec.Lapse {
		all = append(all, c.Captured...)
	}
	return timeline.Union(all)
}

// ---- Admin pages ----

//go:embed admin.html
var adminHTML string

//go:embed admin.css
var adminCSS []byte

func (s *server) adminStyle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Write(adminCSS)
}

func (s *server) adminAddLapse(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	tok := lookoutToken(r.FormValue("lapse"))
	if tok == "" {
		http.Redirect(w, r, "/admin/submissions/"+id+"?err="+url.QueryEscape("That isn't a Lapse or Lookout session link or token (64 hex characters).")+"#lapse", http.StatusSeeOther)
		return
	}
	check := s.checkLapse(tok) // before locking: it waits on Lookout
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, _, _, err := s.loadSubmission(id)
	if err != nil {
		httpError(w, http.StatusNotFound, "no such submission")
		return
	}
	rec.Lapse = setLapse(rec.Lapse, check)
	rec.deflate()
	if s.saveRecord(rec) != nil {
		httpError(w, http.StatusInternalServerError, "could not save")
		return
	}
	http.Redirect(w, r, "/admin/submissions/"+id+"#lapse", http.StatusSeeOther)
}

// records returns every submission record, newest first.
func (s *server) records() []submissionRecord {
	paths, _ := filepath.Glob(filepath.Join(s.dir, "submissions", "*", "record.json"))
	var out []submissionRecord
	for _, p := range paths {
		var rec submissionRecord
		if b, err := os.ReadFile(p); err == nil && json.Unmarshal(b, &rec) == nil {
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ReceivedAt.After(out[j].ReceivedAt) })
	return out
}

type accountRow struct {
	ID       string
	Updated  time.Time
	Engaged  timeline.Seconds
	Projects int
}

func (s *server) adminHome(w http.ResponseWriter, r *http.Request) {
	subs := s.records()
	unchecked := 0
	for _, rec := range subs {
		if len(rec.Lapse) == 0 {
			unchecked++
		}
	}
	s.render(w, http.StatusOK, "home", map[string]any{"Title": "Submissions", "Nav": "queue", "User": s.user(r), "Submissions": subs, "Unchecked": unchecked})
}

func (s *server) adminAccounts(w http.ResponseWriter, r *http.Request) {
	dirs, _ := os.ReadDir(filepath.Join(s.dir, "accounts"))
	var accounts []accountRow
	for _, d := range dirs {
		if _, p, err := s.accountReport(d.Name()); err == nil {
			accounts = append(accounts, accountRow{d.Name(), p.GeneratedAt, p.Report.Engaged, len(p.Report.Projects)})
		}
	}
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].Updated.After(accounts[j].Updated) })
	s.render(w, http.StatusOK, "accounts", map[string]any{"Title": "Accounts", "Nav": "accounts", "User": s.user(r), "Accounts": accounts})
}

func (s *server) adminAccount(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var subs []submissionRecord
	for _, rec := range s.records() {
		if rec.Account == id {
			subs = append(subs, rec)
		}
	}
	_, p, err := s.accountReport(id)
	if err != nil && len(subs) == 0 {
		httpError(w, http.StatusNotFound, "no such account")
		return
	}
	blocks := slices.Clone(p.Report.Blocks)
	slices.Reverse(blocks) // newest first
	s.render(w, http.StatusOK, "account", map[string]any{"Title": id, "Nav": "accounts", "User": s.user(r), "ID": id,
		"Report": p, "HasReport": err == nil, "Blocks": blocks, "Submissions": subs})
}

// chatLog is one log of a submission, as the review page shows it.
type chatLog struct {
	Tool, ID string
	Messages []chatMessage
}

type chatMessage struct {
	sources.Message
	Since   time.Duration // since the message before it
	InLapse bool          // a Lapse session was recording then
	Summary string        // a tool call's first line
	Lines   []diffLine    // the rest of a tool call
}

type diffLine struct{ Text, Kind string }

// engagedRow is one stretch of recomputed engaged time.
type engagedRow struct {
	timeline.Interval
	Lapse time.Duration // of it, covered by Lapse
}

// bar is a stretch of the timeline, in percent of its width.
type bar struct{ Left, Width float64 }

type strip struct {
	From, To       time.Time
	Engaged, Lapse []bar
	Prompts        []float64
}

func makeStrip(from, to time.Time, engaged, lapse []timeline.Interval, prompts []time.Time) strip {
	st := strip{From: from, To: to}
	span := to.Sub(from)
	if span <= 0 {
		return st
	}
	pos := func(t time.Time) float64 { return math.Max(0, math.Min(100, float64(t.Sub(from))*100/float64(span))) }
	bars := func(iv []timeline.Interval) []bar {
		var out []bar
		for _, x := range iv {
			if l, r := pos(x.Start), pos(x.End); r > l {
				out = append(out, bar{l, r - l})
			}
		}
		return out
	}
	st.Engaged, st.Lapse = bars(engaged), bars(lapse)
	for _, p := range prompts {
		st.Prompts = append(st.Prompts, pos(p))
	}
	return st
}

func (s *server) adminSubmission(w http.ResponseWriter, r *http.Request) {
	rec, sub, _, err := s.loadSubmission(r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusNotFound, "no such submission")
		return
	}
	var p submissionPayload
	json.Unmarshal([]byte(sub.Signed.Payload), &p)
	lapse := rec.lapseTime()
	inLapse := func(t time.Time) bool {
		for _, iv := range lapse {
			if !t.Before(iv.Start) && t.Before(iv.End) {
				return true
			}
		}
		return false
	}
	var from, to time.Time
	widen := func(t time.Time) {
		if from.IsZero() || t.Before(from) {
			from = t
		}
		if t.After(to) {
			to = t
		}
	}
	var logs []chatLog
	var prompts []time.Time
	for i, l := range p.Logs {
		if i >= len(sub.Logs) {
			break
		}
		c := chatLog{Tool: l.Tool, ID: l.ID}
		msgs := sources.Transcript(l.Tool, sub.Logs[i])
		for j, m := range msgs {
			widen(m.Time)
			cm := chatMessage{Message: m, InLapse: inLapse(m.Time)}
			if j > 0 {
				cm.Since = m.Time.Sub(msgs[j-1].Time)
			}
			switch m.Role {
			case "you":
				prompts = append(prompts, m.Time)
			case "tool":
				lines := strings.Split(m.Text, "\n")
				cm.Summary = lines[0]
				if len(cm.Summary) > 160 {
					cm.Summary = strings.ToValidUTF8(cm.Summary[:160], "") + "…"
				}
				for _, t := range lines[1:] {
					kind := ""
					switch {
					case strings.HasPrefix(t, "+") && !strings.HasPrefix(t, "+++"):
						kind = "add"
					case strings.HasPrefix(t, "-") && !strings.HasPrefix(t, "---"):
						kind = "del"
					}
					cm.Lines = append(cm.Lines, diffLine{t, kind})
				}
			}
			c.Messages = append(c.Messages, cm)
		}
		logs = append(logs, c)
	}
	var engaged []engagedRow
	for _, iv := range rec.Engaged {
		widen(iv.Start)
		widen(iv.End)
		engaged = append(engaged, engagedRow{iv, timeline.Overlap([]timeline.Interval{iv}, lapse)})
	}
	diff := time.Duration(rec.Claimed) - time.Duration(rec.Recomputed)
	s.render(w, http.StatusOK, "submission", map[string]any{
		"Title": rec.Project.Name, "Nav": "queue", "User": s.user(r), "Rec": rec, "Logs": logs, "Engaged": engaged,
		"Strip":    makeStrip(from, to, rec.Engaged, lapse, prompts),
		"Mismatch": diff > time.Minute || diff < -time.Minute, "Err": r.URL.Query().Get("err"),
	})
}

var adminFuncs = template.FuncMap{
	"dur":   func(d time.Duration) string { return dur(d) },
	"secs":  func(s timeline.Seconds) string { return dur(time.Duration(s)) },
	"when":  func(t time.Time) string { return t.UTC().Format("Jan 2, 15:04 UTC") },
	"clock": func(t time.Time) string { return t.UTC().Format("15:04") },
	"pct":   func(f float64) string { return strconv.FormatFloat(f, 'f', 2, 64) },
	"short": func(s string) string {
		if len(s) > 12 {
			return s[:6] + "…" + s[len(s)-4:]
		}
		return s
	},
	"count": count,
	"gap": func(d time.Duration) string {
		if d < time.Minute {
			return fmt.Sprintf("%ds", int(d/time.Second))
		}
		return dur(d)
	},
	"skipped": func(p timeline.ProjectTotal) int { return p.NoisePrompts + p.RepeatPrompts + p.AutopilotPrompts },
}

var adminTemplates = template.Must(template.New("").Funcs(adminFuncs).Parse(adminHTML))

func (s *server) render(w http.ResponseWriter, code int, name string, data any) {
	var buf bytes.Buffer
	if err := adminTemplates.ExecuteTemplate(&buf, name, data); err != nil {
		log.Printf("rendering %s: %v", name, err)
		httpError(w, http.StatusInternalServerError, "could not show this page")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	w.WriteHeader(code)
	w.Write(buf.Bytes())
}
