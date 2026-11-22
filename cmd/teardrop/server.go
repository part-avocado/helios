package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/timeline"
	"github.com/part-avocado/teardrop/site"
)

// server is the central server. Anyone can see an account's totals; the
// details behind them (work blocks, submissions, and their chat logs) are
// for admins only, who sign in with Hack Club Auth and are listed by Slack user ID.
// Accounts are their signing keys, registered on first upload. Everything is
// stored as files under dir, so a small VPS runs it.
type server struct {
	dir      string
	maxBody  int64
	admins   map[string]bool // Slack user IDs
	hca      hcaApp
	secret   []byte // signs sign-in cookies
	devLogin string // Slack user ID every visitor is signed in as; local testing only
	client   *http.Client
	mu       sync.Mutex
}

// runServer serves the central server API and the admin pages.
func runServer(args []string) {
	fs := flag.NewFlagSet("server", flag.ExitOnError)
	addr := fs.String("addr", ":8080", "address to listen on")
	dir := fs.String("data", "teardrop-data", "directory to store accounts and submissions in")
	maxMB := fs.Int64("max-submission-mb", 256, "largest submission accepted, in MB")
	publicURL := fs.String("public-url", os.Getenv("TEARDROP_PUBLIC_URL"), "URL people reach this server at, for Hack Club Auth sign-in")
	devLogin := fs.String("dev-login", "", "sign every visitor in as this Slack user ID, without Hack Club Auth (only on a localhost address)")
	fs.Parse(args)

	if *devLogin != "" {
		host, _, _ := net.SplitHostPort(*addr)
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			check(fmt.Errorf("-dev-login skips sign-in, so it only works with a localhost -addr such as 127.0.0.1:8080"))
		}
	}
	check(os.MkdirAll(*dir, 0o700))
	secret, err := sessionSecret(*dir)
	check(err)
	s := &server{
		dir: *dir, maxBody: *maxMB << 20, admins: map[string]bool{}, secret: secret, devLogin: *devLogin,
		client: &http.Client{Timeout: 15 * time.Second},
		hca: hcaApp{
			base: "https://auth.hackclub.com", clientID: os.Getenv("TEARDROP_HCA_CLIENT_ID"), clientSecret: os.Getenv("TEARDROP_HCA_CLIENT_SECRET"),
			redirect: strings.TrimRight(*publicURL, "/") + "/auth/callback",
		},
	}
	for _, id := range strings.FieldsFunc(os.Getenv("TEARDROP_ADMINS"), func(r rune) bool { return r == ',' || r == ' ' }) {
		s.admins[id] = true
	}
	if *devLogin != "" {
		s.admins[*devLogin] = true
	}
	switch {
	case len(s.admins) == 0:
		log.Print("TEARDROP_ADMINS is empty, so no one can review submissions; set it to admins' Slack user IDs, comma-separated")
	case *devLogin == "" && (s.hca.clientID == "" || s.hca.clientSecret == "" || *publicURL == ""):
		log.Print("Hack Club Auth sign-in is not set up; set TEARDROP_HCA_CLIENT_ID, TEARDROP_HCA_CLIENT_SECRET, and -public-url")
	}
	log.Printf("teardrop server listening on %s, storing data in %s", *addr, *dir)
	// No limit on reading a body: a large submission on a slow connection takes a while.
	srv := &http.Server{Addr: *addr, Handler: s.handler(), ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 2 * time.Minute}
	check(srv.ListenAndServe())
}

var accountRe = regexp.MustCompile(`^td-[0-9a-f]{12}$`)
var submissionRe = regexp.MustCompile(`^sub-[0-9a-f]{16}$`)

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(site.FS))
	mux.HandleFunc("POST /api/v1/reports", s.postReport)
	mux.HandleFunc("GET /api/v1/accounts/{id}", s.getProfile)
	mux.HandleFunc("GET /api/v1/accounts/{id}/report", s.admin(s.getReport))
	mux.HandleFunc("POST /api/v1/submissions", s.postSubmission)
	mux.HandleFunc("GET /api/v1/submissions/{id}", s.admin(s.getSubmission))
	mux.HandleFunc("GET /admin.css", s.adminStyle)
	mux.HandleFunc("GET /login", s.login)
	mux.HandleFunc("GET /auth/callback", s.authCallback)
	mux.HandleFunc("POST /logout", s.logout)
	mux.HandleFunc("GET /admin", s.admin(s.adminHome))
	mux.HandleFunc("GET /admin/submissions/{id}", s.admin(s.adminSubmission))
	mux.HandleFunc("GET /admin/accounts", s.admin(s.adminAccounts))
	mux.HandleFunc("GET /admin/accounts/{id}", s.admin(s.adminAccount))
	return mux
}

func httpError(w http.ResponseWriter, code int, format string, a ...any) {
	http.Error(w, fmt.Sprintf(format, a...), code)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// writeFile replaces path atomically, so readers never see half a file.
func writeFile(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func accountOf(h signedHeader) string {
	pub, _ := base64.RawURLEncoding.DecodeString(h.Account)
	return accountID(ed25519.PublicKey(pub))
}

// postReport stores an account's signed counts if they are newer than the
// ones it has.
func (s *server) postReport(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil {
		httpError(w, http.StatusRequestEntityTooLarge, "report too large")
		return
	}
	var signed SignedReport
	if json.Unmarshal(body, &signed) != nil {
		httpError(w, http.StatusBadRequest, "not a signed teardrop report")
		return
	}
	h, err := verifySigned(signed, time.Now())
	if err == nil && h.Kind != "" {
		err = errors.New("this is a submission; send it to /api/v1/submissions")
	}
	var p exportPayload
	if err == nil && json.Unmarshal([]byte(signed.Payload), &p) != nil {
		err = errors.New("damaged report")
	}
	if err == nil {
		err = blocksBefore(p.Report, h.GeneratedAt)
	}
	if err != nil {
		httpError(w, http.StatusBadRequest, "report refused: %v", err)
		return
	}
	id := accountOf(h)
	path := filepath.Join(s.dir, "accounts", id, "report.json")
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, err := os.ReadFile(path); err == nil {
		var prev SignedReport
		var ph signedHeader
		if json.Unmarshal(old, &prev) == nil && json.Unmarshal([]byte(prev.Payload), &ph) == nil && !h.GeneratedAt.After(ph.GeneratedAt) {
			httpError(w, http.StatusConflict, "the server already has a newer report from this account")
			return
		}
	}
	if err := writeFile(path, body); err != nil {
		httpError(w, http.StatusInternalServerError, "could not store the report")
		return
	}
	writeJSON(w, map[string]string{"account": id})
}

// accountReport reads an account's latest signed report.
func (s *server) accountReport(id string) (SignedReport, exportPayload, error) {
	var signed SignedReport
	var p exportPayload
	if !accountRe.MatchString(id) {
		return signed, p, os.ErrNotExist
	}
	b, err := os.ReadFile(filepath.Join(s.dir, "accounts", id, "report.json"))
	if err != nil {
		return signed, p, err
	}
	if json.Unmarshal(b, &signed) != nil || json.Unmarshal([]byte(signed.Payload), &p) != nil {
		return signed, p, errors.New("damaged report")
	}
	return signed, p, nil
}

// Profile is what anyone can see of an account: totals, without the work
// blocks or sessions behind them.
type Profile struct {
	Account   string           `json:"account"`
	UpdatedAt time.Time        `json:"updated_at"`
	Engaged   timeline.Seconds `json:"engaged_seconds"`
	Projects  []ProfileProject `json:"projects"`
}

type ProfileProject struct {
	Name    string           `json:"name"`
	Engaged timeline.Seconds `json:"engaged_seconds"`
}

// getProfile serves an account's public totals.
func (s *server) getProfile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_, p, err := s.accountReport(id)
	if err != nil {
		httpError(w, http.StatusNotFound, "no such account")
		return
	}
	prof := Profile{Account: id, UpdatedAt: p.GeneratedAt, Engaged: p.Report.Engaged, Projects: []ProfileProject{}}
	for _, pt := range p.Report.Projects {
		prof.Projects = append(prof.Projects, ProfileProject{Name: pt.Project.Name, Engaged: pt.Engaged})
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	writeJSON(w, prof)
}

// getReport serves an account's latest signed report, blocks included, to admins.
func (s *server) getReport(w http.ResponseWriter, r *http.Request) {
	signed, _, err := s.accountReport(r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusNotFound, "no such account")
		return
	}
	writeJSON(w, signed)
}

// submissionRecord is what the server keeps besides the submission itself:
// the hours it recomputed from the logs, and what it credits.
type submissionRecord struct {
	ID         string              `json:"id"`
	Account    string              `json:"account"`
	Project    timeline.Project    `json:"project"`
	ReceivedAt time.Time           `json:"received_at"`
	Claimed    timeline.Seconds    `json:"claimed_seconds"`
	Recomputed timeline.Seconds    `json:"recomputed_seconds"`
	Engaged    []timeline.Interval `json:"engaged"` // recomputed engaged time
	// Recomputed time that this account's earlier submissions of the project
	// already cover, so sending a project again doesn't count its hours twice.
	Earlier        []timeline.Interval `json:"earlier,omitempty"`
	EarlierOverlap timeline.Seconds    `json:"earlier_overlap_seconds"`
	// What is left to credit once that is taken off.
	Credited timeline.Seconds `json:"credited_seconds"`
}

// postSubmission accepts a project's hours only with the logs behind every
// claimed block, recomputing the time from those logs.
func (s *server) postSubmission(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.maxBody))
	if err != nil {
		httpError(w, http.StatusRequestEntityTooLarge, "submission larger than %d MB", s.maxBody>>20)
		return
	}
	var sub Submission
	if json.Unmarshal(body, &sub) != nil {
		httpError(w, http.StatusBadRequest, "not a teardrop submission")
		return
	}
	rec, err := checkSubmission(sub, time.Now())
	if err != nil {
		httpError(w, http.StatusBadRequest, "submission refused: %v", err)
		return
	}
	sum := sha256.Sum256([]byte(sub.Signed.Payload))
	rec.ID = "sub-" + hex.EncodeToString(sum[:8])
	// The same submission sent again keeps its record.
	if old, _, _, err := s.loadSubmission(rec.ID); err == nil {
		writeJSON(w, old)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, old := range s.records() {
		if old.Account == rec.Account && old.Project.Key == rec.Project.Key && old.ID != rec.ID {
			rec.Earlier = append(rec.Earlier, old.Engaged...)
		}
	}
	rec.Earlier = timeline.Union(rec.Earlier)
	rec.deflate()
	dir := filepath.Join(s.dir, "submissions", rec.ID)
	if writeFile(filepath.Join(dir, "submission.json"), body) != nil || s.saveRecord(rec) != nil {
		httpError(w, http.StatusInternalServerError, "could not store the submission")
		return
	}
	writeJSON(w, rec)
}

func (s *server) saveRecord(rec submissionRecord) error {
	meta, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return writeFile(filepath.Join(s.dir, "submissions", rec.ID, "record.json"), meta)
}

// checkSubmission verifies a submission's signature and logs, and recomputes
// its hours from the logs alone.
func checkSubmission(sub Submission, now time.Time) (submissionRecord, error) {
	var rec submissionRecord
	h, err := verifySigned(sub.Signed, now)
	if err != nil {
		return rec, err
	}
	var p submissionPayload
	if h.Kind != "submission" || json.Unmarshal([]byte(sub.Signed.Payload), &p) != nil {
		return rec, errors.New("this is not a submission; make one with `teardrop submit`")
	}
	if err := blocksBefore(p.Report, h.GeneratedAt); err != nil {
		return rec, err
	}
	if len(p.Logs) == 0 || len(p.Logs) != len(sub.Logs) {
		return rec, errors.New("the chat logs are missing")
	}
	window, err := parseSince(p.Since)
	if err != nil {
		return rec, err
	}

	// Parse the logs the way the client does, with one shared Claude parser
	// so copies of one response count once.
	claude := sources.ClaudeParser()
	var raws []sources.Raw
	for i, l := range p.Logs {
		sum := sha256.Sum256(sub.Logs[i])
		if hex.EncodeToString(sum[:]) != l.SHA256 {
			return rec, fmt.Errorf("log %d (%s %s) is not the one that was signed", i+1, l.Tool, l.ID)
		}
		var parsed []sources.Raw
		switch l.Tool {
		case "claude-code":
			r, _ := claude(bytes.NewReader(sub.Logs[i]), l.ID)
			parsed = []sources.Raw{r}
		case "codex":
			r, _ := sources.ParseCodex(bytes.NewReader(sub.Logs[i]), l.ID)
			parsed = []sources.Raw{r}
		case "journal":
			parsed, _ = sources.ParseJournal(bytes.NewReader(sub.Logs[i]), l.ID)
		default:
			return rec, fmt.Errorf("log %d has unknown tool %q", i+1, l.Tool)
		}
		raws = append(raws, parsed...)
	}
	// The server has no copy of the repository, so it can't use its
	// vocabulary or commits; every log belongs to the submitted project.
	sessions, _ := buildSessions(raws, h.GeneratedAt.Add(-window), newLookups(func(sources.Raw) (timeline.Project, string) {
		return p.Project, ""
	}))
	got := timeline.Build(sessions, timeline.DefaultRules)
	// The hours come from the logs, so they too must end before the signing time.
	if err := blocksBefore(got, h.GeneratedAt); err != nil {
		return rec, errors.New("its logs have activity after the time it was made")
	}

	// Every claimed block must overlap time the logs earn.
	for _, b := range p.Report.Blocks {
		backed := false
		for _, e := range got.Blocks {
			if e.Start.Before(b.End) && e.End.After(b.Start) {
				backed = true
				break
			}
		}
		if !backed {
			return rec, fmt.Errorf("no log backs the block %s to %s", b.Start.Format(time.RFC3339), b.End.Format(time.RFC3339))
		}
	}
	return submissionRecord{
		Account: accountOf(h), Project: p.Project, ReceivedAt: now.UTC(),
		Claimed: p.Report.Engaged, Recomputed: got.Engaged,
		Engaged: timeline.Engaged(sessions, timeline.DefaultRules),
	}, nil
}

// blocksBefore refuses activity after the time a file says it was made.
func blocksBefore(rep timeline.Report, generated time.Time) error {
	for _, b := range rep.Blocks {
		if b.End.After(generated.Add(clockSkew)) {
			return errors.New("it has activity after the time it was made")
		}
	}
	return nil
}

// loadSubmission reads a stored submission and its record.
func (s *server) loadSubmission(id string) (submissionRecord, Submission, []byte, error) {
	var rec submissionRecord
	var sub Submission
	if !submissionRe.MatchString(id) {
		return rec, sub, nil, os.ErrNotExist
	}
	dir := filepath.Join(s.dir, "submissions", id)
	meta, err := os.ReadFile(filepath.Join(dir, "record.json"))
	if err != nil {
		return rec, sub, nil, err
	}
	body, err := os.ReadFile(filepath.Join(dir, "submission.json"))
	if err != nil {
		return rec, sub, nil, err
	}
	if json.Unmarshal(meta, &rec) != nil || json.Unmarshal(body, &sub) != nil {
		return rec, sub, nil, errors.New("damaged submission")
	}
	return rec, sub, body, nil
}

// getSubmission serves a submission with its logs to admins.
func (s *server) getSubmission(w http.ResponseWriter, r *http.Request) {
	rec, _, body, err := s.loadSubmission(r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusNotFound, "no such submission")
		return
	}
	meta, _ := json.Marshal(rec)
	writeJSON(w, map[string]json.RawMessage{"record": meta, "submission": body})
}
