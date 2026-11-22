package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

// An Amp thread that runs in Amp's cloud has no computer of the person's to
// keep a journal on. There, the cloud plugin runs `teardrop hook amp -relay`,
// which hands each event to the person's teardrop site. One of their own
// computers takes the events into its journal at its next sync and counts
// them with everything else, so no moment is counted twice.

const (
	// relayOutbox holds events that are waiting to go to the site.
	relayOutbox = "relay-outbox.jsonl"
	// The outbox stops growing here, such as in an orb without a sync key.
	maxOutboxBytes = 4 << 20
	// One upload holds at most this much, which the site accepts.
	relayBatchBytes = 200 << 10
	// A plugin may hand an event over this long after it happened.
	relayLateness = time.Hour
)

// happenedAt returns when an event the plugin hands over at now happened:
// the time the plugin gives, if that is at most relayLateness ago, else now.
func happenedAt(now time.Time, given string) time.Time {
	if t, err := time.Parse(time.RFC3339Nano, given); err == nil && t.Before(now) && now.Sub(t) < relayLateness {
		return t.UTC()
	}
	return now
}

// queueRelay adds ev to the outbox with one append, so parallel hooks don't interleave.
func queueRelay(ev sources.JournalEvent) error {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return err
	}
	path := filepath.Join(dataDir(), relayOutbox)
	if st, err := os.Stat(path); err == nil && st.Size() > maxOutboxBytes {
		return nil
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// relaySoon sends the outbox in the background. Hooks call it, so it never waits.
func relaySoon() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command(exe, "relay")
	if cmd.Start() == nil {
		cmd.Process.Release()
	}
}

// runRelay sends the outbox to the site named by $TEARDROP_SERVER, as the
// person whose sync key is in $TEARDROP_KEY. Without both it does nothing,
// and the events wait.
func runRelay(args []string) {
	fs := flag.NewFlagSet("relay", flag.ExitOnError)
	verbose := fs.Bool("verbose", false, "say what was sent, or why nothing was")
	fs.Parse(args)
	err := func() error {
		server, err := serverURL("")
		if err != nil {
			return err
		}
		key, err := syncKey("", server)
		if err != nil {
			return err
		}
		if key == "" {
			return fmt.Errorf("no sync key set; put yours in $TEARDROP_KEY")
		}
		client := &http.Client{Timeout: time.Minute}
		return sendOutbox(dataDir(), func(lines []byte) (int, error) {
			return relayRequest(client, "POST", server+"/api/v1/events", key, lines, nil)
		})
	}()
	if *verbose {
		check(err)
		fmt.Println("Sent.")
	}
}

// sendOutbox uploads the events waiting in dir, in batches, through send,
// which returns the site's HTTP status. Events it could not upload stay for
// the next run; the site drops any it is sent twice.
func sendOutbox(dir string, send func(lines []byte) (int, error)) error {
	// Take what is waiting, so events that arrive meanwhile start a new file.
	os.Rename(filepath.Join(dir, relayOutbox), filepath.Join(dir, fmt.Sprintf("relay-sending-%d.jsonl", time.Now().UnixNano())))
	files, _ := filepath.Glob(filepath.Join(dir, "relay-sending-*.jsonl"))
	for _, path := range files {
		b, err := os.ReadFile(path)
		if err != nil {
			continue // another run sent it first
		}
		for len(b) > 0 {
			n := len(b)
			if n > relayBatchBytes {
				n = bytes.LastIndexByte(b[:relayBatchBytes], '\n') + 1
				if n == 0 {
					n = len(b)
				}
			}
			status, err := send(b[:n])
			// A batch the site will never take is dropped, so it can't block the rest.
			if err != nil && status != http.StatusBadRequest && status != http.StatusRequestEntityTooLarge {
				return err
			}
			b = b[n:]
		}
		os.Remove(path)
	}
	return nil
}

// relayRequest calls the site's events API with the sync key. It decodes a
// JSON answer into out, when given one, and returns the HTTP status.
func relayRequest(client *http.Client, method, address, key string, body []byte, out any) (int, error) {
	req, err := http.NewRequest(method, address, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode != http.StatusOK {
		return res.StatusCode, fmt.Errorf("server said %s: %s", res.Status, strings.TrimSpace(string(b)))
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			return res.StatusCode, fmt.Errorf("server sent an answer teardrop can't read: %w", err)
		}
	}
	return res.StatusCode, nil
}

// pullRelayed moves the person's cloud events from the site into this
// computer's journal, and returns how many it took. The site hands them to
// one computer only. A site without cloud events is not an error.
func pullRelayed(client *http.Client, server, key string) (int, error) {
	priv, err := accountKey()
	if err != nil {
		return 0, err
	}
	id := accountID(priv.Public().(ed25519.PublicKey))
	// The cursor is the last event taken, which the site may then forget. It
	// holds for one account on one server only: with another's, the site
	// would forget events this computer never took.
	cursorPath := filepath.Join(dataDir(), "relay-cursor")
	sum := sha256.Sum256([]byte(server + "\x00" + key))
	whose := hex.EncodeToString(sum[:8])
	var after int64
	if b, err := os.ReadFile(cursorPath); err == nil {
		if from, n, ok := strings.Cut(strings.TrimSpace(string(b)), "\n"); ok && from == whose {
			after, _ = strconv.ParseInt(n, 10, 64)
		}
	}
	taken := 0
	for {
		var page struct {
			Last  int64    `json:"last"`
			Lines []string `json:"lines"`
		}
		q := url.Values{"computer": {id}, "after": {strconv.FormatInt(after, 10)}}
		status, err := relayRequest(client, "GET", server+"/api/v1/events?"+q.Encode(), key, nil, &page)
		if status == http.StatusNotFound {
			return taken, nil
		}
		if err != nil {
			return taken, err
		}
		if len(page.Lines) == 0 || page.Last <= after {
			return taken, nil
		}
		latest := time.Now().Add(5 * time.Minute)
		for _, line := range page.Lines {
			var ev sources.JournalEvent
			// Only what the cloud plugin sends is taken, and nothing from the future.
			if json.Unmarshal([]byte(line), &ev) != nil || ev.Tool != "amp" || ev.Session == "" || ev.Time.IsZero() || ev.Time.After(latest) {
				continue
			}
			if err := sources.AppendJournal(dataDir(), ev); err != nil {
				return taken, err
			}
			taken++
		}
		after = page.Last
		// Asking again with the new cursor is what lets the site forget these.
		if err := os.WriteFile(cursorPath, []byte(whose+"\n"+strconv.FormatInt(after, 10)+"\n"), 0o600); err != nil {
			return taken, err
		}
	}
}
