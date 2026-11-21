package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// keyLifetime is how long an exported report's key stays valid. The
// dashboard refuses older files, so a stale or replayed file can't stand in
// for current numbers.
const keyLifetime = 7 * 24 * time.Hour

// SignedReport is what `teardrop export` writes and the dashboard requires.
// Key is an Ed25519 signature of Payload's exact bytes by the account named
// inside Payload, so changing any number, the account, or a time breaks it.
type SignedReport struct {
	Version int    `json:"v"`
	Payload string `json:"payload"` // JSON of exportPayload, kept as text so it verifies byte for byte
	Key     string `json:"key"`     // base64url signature
}

type exportPayload struct {
	Account     string          `json:"account"` // base64url Ed25519 public key
	GeneratedAt time.Time       `json:"generated_at"`
	ExpiresAt   time.Time       `json:"expires_at"`
	Since       string          `json:"since"`
	Teardrop    string          `json:"teardrop_version"`
	Report      timeline.Report `json:"report"`
}

// accountKey loads this install's signing key, creating it on first use.
func accountKey() (ed25519.PrivateKey, error) {
	path := filepath.Join(dataDir(), "account.key")
	if b, err := os.ReadFile(path); err == nil {
		seed, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(b)))
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("%s is damaged; delete it to make a new account key", path)
		}
		return ed25519.NewKeyFromSeed(seed), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return nil, err
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return accountKey() // another teardrop created it first
	}
	if err != nil {
		return nil, err
	}
	_, err = f.WriteString(base64.RawURLEncoding.EncodeToString(priv.Seed()) + "\n")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return priv, err
}

// accountID is a short, readable name for a public key, such as td-3f9a1c0b77e2.
func accountID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return "td-" + hex.EncodeToString(sum[:6])
}

// signReport signs rep as generated now.
func signReport(rep timeline.Report, since string, now time.Time) (SignedReport, error) {
	return signPayload(func(account string) any {
		return exportPayload{
			Account:     account,
			GeneratedAt: now.UTC(),
			ExpiresAt:   now.UTC().Add(keyLifetime),
			Since:       since,
			Teardrop:    version,
			Report:      rep,
		}
	})
}

// signPayload signs the JSON of the payload that build makes for this
// install's account, given as a base64url public key.
func signPayload(build func(account string) any) (SignedReport, error) {
	priv, err := accountKey()
	if err != nil {
		return SignedReport{}, err
	}
	payload, err := json.Marshal(build(base64.RawURLEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))))
	if err != nil {
		return SignedReport{}, err
	}
	return SignedReport{
		Version: 1,
		Payload: string(payload),
		Key:     base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, payload)),
	}, nil
}

// signedHeader holds the fields every signed payload has.
type signedHeader struct {
	Kind        string    `json:"kind"` // "" for a report, "submission" for a submission
	Account     string    `json:"account"`
	GeneratedAt time.Time `json:"generated_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// clockSkew is how far ahead of this clock a signed file may say it was made.
const clockSkew = 5 * time.Minute

// verifySigned checks that s was signed by the account it names, was made
// before now, and has not expired, the same checks the dashboard makes.
func verifySigned(s SignedReport, now time.Time) (signedHeader, error) {
	var h signedHeader
	if s.Version != 1 || json.Unmarshal([]byte(s.Payload), &h) != nil {
		return h, errors.New("not a signed teardrop file")
	}
	pub, err1 := base64.RawURLEncoding.DecodeString(h.Account)
	sig, err2 := base64.RawURLEncoding.DecodeString(s.Key)
	if err1 != nil || err2 != nil || len(pub) != ed25519.PublicKeySize || !ed25519.Verify(pub, []byte(s.Payload), sig) {
		return h, errors.New("the key does not match the contents; it was changed after it was signed")
	}
	switch {
	case h.GeneratedAt.After(now.Add(clockSkew)):
		return h, errors.New("it says it was made in the future; check the clock")
	case !now.Before(h.ExpiresAt):
		return h, fmt.Errorf("its key expired on %s", h.ExpiresAt.Format(time.RFC3339))
	case h.ExpiresAt.Sub(h.GeneratedAt) > keyLifetime:
		return h, errors.New("its key is valid for longer than teardrop allows")
	}
	return h, nil
}

// runExport writes a signed report for the dashboard.
func runExport(args []string) {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	since := fs.String("since", "365d", "only count events newer than this, such as 30d or 365d")
	out := fs.String("o", "", "write to this file instead of standard output")
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	fs.Parse(args)
	window, err := parseSince(*since)
	check(err)

	now := time.Now()
	raws, _ := loadAll(*claudeDir, *codexDir)
	rep, _ := buildReport(raws, now.Add(-window), timeline.DefaultRules)
	signed, err := signReport(rep, *since, now)
	check(err)
	b, err := json.Marshal(signed)
	check(err)
	b = append(b, '\n')
	if *out == "" {
		os.Stdout.Write(b)
	} else {
		check(os.WriteFile(*out, b, 0o644))
	}
	priv, _ := accountKey()
	fmt.Fprintf(os.Stderr, "Signed by account %s. The key is valid until %s; upload it on the website, under Settings, before then.\n",
		accountID(priv.Public().(ed25519.PublicKey)), now.Add(keyLifetime).Local().Format("Mon Jan 2 15:04"))
}
