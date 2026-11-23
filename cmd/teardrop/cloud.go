package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/timeline"
)

// Amp threads that run in Amp's cloud are counted in the cloud, with no
// computer of the person's involved. The site keeps every event the cloud
// plugin sends. When a thread finishes a turn, the teardrop running there
// reads all of the person's cloud events back, counts them with the rules
// `teardrop sync` uses, and uploads the report as the person's cloud
// computer. Every thread signs with the same key, which the site hands out,
// so they all sync as one computer. Because one count covers every thread,
// threads that ran side by side count once.

// countCloud counts the cloud threads of the person whose sync key is key
// and syncs the result to server.
func countCloud(client *http.Client, server, key string, now time.Time) error {
	// Each account's events are kept apart, so a machine that changes
	// accounts never counts one's events for the other.
	sum := sha256.Sum256([]byte(server + "\x00" + key))
	dir := filepath.Join(dataDir(), "cloud-"+hex.EncodeToString(sum[:8]))
	priv, err := pullCloud(client, server, key, dir)
	if err != nil {
		return err
	}
	raws, _ := sources.ReadJournal(dir)
	window, _ := parseSince(syncWindow)
	rep, _ := buildReportWith(newLookups(cloudProject), raws, now.Add(-window), timeline.DefaultRules)
	signed, err := signWith(priv, reportPayload(rep, syncWindow, now))
	if err != nil {
		return err
	}
	b, err := json.Marshal(signed)
	if err != nil {
		return err
	}
	_, err = relayRequest(client, "POST", server+"/api/v1/reports", key, b, nil)
	return err
}

// cloudProject names a cloud thread's project by the repository its events
// carry, else by its folder. It looks nothing up on this machine: the thread
// may have run on another, where the same folder held another project. A
// folder is kept as it is: it is on Amp's machine, and this machine's home
// folder says nothing about it.
func cloudProject(r sources.Raw) (timeline.Project, string) {
	if r.GitURL == "" && r.Cwd != "" {
		return timeline.Project{Key: r.Cwd, Name: filepath.Base(r.Cwd)}, ""
	}
	return nameProject(r.Cwd, r.GitURL), ""
}

// pullCloud copies the person's cloud events that dir doesn't hold yet from
// the site into dir, as a journal, and returns the key their cloud computer
// signs with. A new machine starts with none, so it copies them all.
func pullCloud(client *http.Client, server, key, dir string) (ed25519.PrivateKey, error) {
	cursorPath := filepath.Join(dir, "cursor") // the last event copied
	var after int64
	if b, err := os.ReadFile(cursorPath); err == nil {
		after, _ = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	}
	for {
		var page struct {
			Key   string   `json:"key"`
			Last  int64    `json:"last"`
			Lines []string `json:"lines"`
		}
		q := url.Values{"after": {strconv.FormatInt(after, 10)}}
		if _, err := relayRequest(client, "GET", server+"/api/v1/cloud?"+q.Encode(), key, nil, &page); err != nil {
			return nil, err
		}
		if len(page.Lines) == 0 || page.Last <= after {
			seed, err := base64.RawURLEncoding.DecodeString(page.Key)
			if err != nil || len(seed) != ed25519.SeedSize {
				return nil, errors.New("the server sent no key to sign cloud threads with")
			}
			return ed25519.NewKeyFromSeed(seed), nil
		}
		latest := time.Now().Add(clockSkew)
		for _, line := range page.Lines {
			var ev sources.JournalEvent
			// Only what the cloud plugin sends is taken, and nothing from the future.
			if json.Unmarshal([]byte(line), &ev) != nil || ev.Tool != "amp" || ev.Session == "" || ev.Time.IsZero() || ev.Time.After(latest) {
				continue
			}
			if err := sources.AppendJournal(dir, ev); err != nil {
				return nil, err
			}
		}
		after = page.Last
		// Stopped between the two writes, the next run copies this page again;
		// reading the journal drops the repeats.
		if err := os.WriteFile(cursorPath, []byte(strconv.FormatInt(after, 10)+"\n"), 0o600); err != nil {
			return nil, err
		}
	}
}
