package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
)

// An Amp thread that runs in Amp's cloud has no computer of the person's to
// keep a journal on. There, the cloud plugin runs `teardrop hook amp -relay`,
// which hands each event to the person's teardrop site. The site keeps them,
// and a thread that finishes a turn counts them all (cloud.go).

const (
	// relayOutbox holds cloud events that are waiting to go to the site.
	relayOutbox = "relay-outbox.jsonl"
	// localOutbox holds this computer's hook records that are waiting to go to the site.
	localOutbox = "local-outbox.jsonl"
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

// queueRelay adds ev to an outbox with one append, so parallel hooks don't interleave.
func queueRelay(outbox string, ev sources.JournalEvent) error {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return err
	}
	path := filepath.Join(dataDir(), outbox)
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

// relaySoon sends the outbox in the background, and with count, because a
// turn ended, counts the person's cloud threads after. Hooks call it, so it
// never waits.
func relaySoon(count bool) {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command(exe, "relay")
	if count {
		cmd.Args = append(cmd.Args, "-count")
	}
	detach(cmd)
	if cmd.Start() == nil {
		cmd.Process.Release()
	}
}

// runRelay sends the outbox to the site named by $TEARDROP_SERVER, as the
// person whose sync key is in $TEARDROP_KEY. Without both it does nothing,
// and the events wait. With -count it then counts the person's cloud threads
// and syncs the result.
func runRelay(args []string) {
	fs := flag.NewFlagSet("relay", flag.ExitOnError)
	count := fs.Bool("count", false, "then count your cloud threads and sync the result")
	verbose := fs.Bool("verbose", false, "say what was sent, or why nothing was")
	fs.Parse(args)
	counted, err := func() (bool, error) {
		server, err := serverURL("")
		if err != nil {
			return false, err
		}
		key, err := syncKey("", server)
		if err != nil {
			return false, err
		}
		if key == "" {
			return false, fmt.Errorf("no sync key set; put yours in $TEARDROP_KEY")
		}
		client := &http.Client{Timeout: time.Minute}
		header := http.Header{}
		if hasFile(localOutbox) {
			if header, err = computerHeader(); err != nil {
				return false, err
			}
			if err := sendOutbox(dataDir(), localOutbox, func(lines []byte) (int, error) {
				return relayRequestWith(client, "POST", server+"/api/v1/events", key, lines, nil, header)
			}); err != nil {
				return false, err
			}
		}
		header.Set("X-Teardrop-Computer", "cloud")
		err = sendOutbox(dataDir(), relayOutbox, func(lines []byte) (int, error) {
			return relayRequestWith(client, "POST", server+"/api/v1/events", key, lines, nil, header)
		})
		if err != nil || !*count {
			return false, err
		}
		return true, countCloud(client, server, key, time.Now())
	}()
	if *verbose {
		check(err)
		fmt.Println("Sent.")
		if counted {
			fmt.Println("Counted your cloud threads and synced them.")
		}
	}
}

// hasFile reports whether dataDir holds an outbox, or one being sent.
func hasFile(outbox string) bool {
	files, _ := filepath.Glob(filepath.Join(dataDir(), strings.TrimSuffix(outbox, "-outbox.jsonl")+"-*.jsonl"))
	return len(files) > 0
}

// sendOutbox uploads the events waiting in one outbox in dir, in batches,
// through send, which returns the site's HTTP status. Events it could not
// upload stay for the next run; the site drops any it is sent twice.
func sendOutbox(dir, outbox string, send func(lines []byte) (int, error)) error {
	// Take what is waiting, so events that arrive meanwhile start a new file.
	sending := strings.TrimSuffix(outbox, "-outbox.jsonl") + "-sending-"
	os.Rename(filepath.Join(dir, outbox), filepath.Join(dir, fmt.Sprintf("%s%d.jsonl", sending, time.Now().UnixNano())))
	files, _ := filepath.Glob(filepath.Join(dir, sending+"*.jsonl"))
	for _, path := range files {
		b, err := os.ReadFile(path)
		if err != nil {
			continue // another run sent it first
		}
		if err := sendLines(b, send); err != nil {
			return err
		}
		os.Remove(path)
	}
	return nil
}

// sendLines uploads JSON lines in batches of whole lines through send, which
// returns the site's HTTP status. It stops at the first batch the site may
// take later; a batch it will never take is dropped, so it can't block the rest.
func sendLines(b []byte, send func(lines []byte) (int, error)) error {
	for len(b) > 0 {
		n := len(b)
		if n > relayBatchBytes {
			n = bytes.LastIndexByte(b[:relayBatchBytes], '\n') + 1
			if n == 0 {
				n = len(b)
			}
		}
		status, err := send(b[:n])
		if err != nil && status != http.StatusBadRequest && status != http.StatusRequestEntityTooLarge {
			return err
		}
		b = b[n:]
	}
	return nil
}

// relayRequest calls the site's events API with the sync key. It decodes a
// JSON answer into out, when given one, and returns the HTTP status.
func relayRequest(client *http.Client, method, address, key string, body []byte, out any) (int, error) {
	return relayRequestWith(client, method, address, key, body, out, nil)
}

// relayRequestWith is relayRequest with more request headers.
func relayRequestWith(client *http.Client, method, address, key string, body []byte, out any, header http.Header) (int, error) {
	req, err := http.NewRequest(method, address, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	for k, v := range header {
		req.Header[k] = v
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
