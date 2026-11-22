package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSyncKeyGoesOnlyToItsServer(t *testing.T) {
	t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
	t.Setenv("TEARDROP_SERVER", "")
	t.Setenv("TEARDROP_KEY", "")
	var got string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
	}))
	defer ts.Close()

	// `teardrop sync -server ... -key ...` remembers both for later runs.
	srv, err := serverURL(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := syncKey("tdk_mine", srv); err != nil {
		t.Fatal(err)
	}
	srv, _ = serverURL("")
	key, _ := syncKey("", srv)
	if _, err := post(srv, key, "/api/v1/reports", nil); err != nil || got != "Bearer tdk_mine" {
		t.Fatalf("a later sync sent Authorization %q (%v), want the remembered key", got, err)
	}

	t.Setenv("TEARDROP_SERVER", "https://elsewhere.example")
	srv, _ = serverURL("")
	if key, _ := syncKey("", srv); srv != "https://elsewhere.example" || key != "" {
		t.Errorf("$TEARDROP_SERVER: server %q got key %q, want none", srv, key)
	}
	t.Setenv("TEARDROP_SERVER", "")
	srv, _ = serverURL("https://new.example")
	if key, _ := syncKey("", srv); key != "" {
		t.Errorf("after switching servers, the new one got the old key %q", key)
	}
}

func TestSyncQueued(t *testing.T) {
	dir := t.TempDir()
	lock, note := filepath.Join(dir, "sync.lock"), filepath.Join(dir, "sync-wanted")
	runs := 0
	// A turn ends while the first sync runs: it goes once more, then stops.
	err := syncQueued(dir, func() error {
		if runs++; runs == 1 {
			if _, err := os.Stat(lock); err != nil {
				t.Error("no lock was held while syncing")
			}
			os.WriteFile(note, nil, 0o600)
			ended := time.Now().Add(20 * time.Millisecond)
			os.Chtimes(note, ended, ended)
			time.Sleep(40 * time.Millisecond)
		}
		return nil
	})
	if err != nil || runs != 2 {
		t.Errorf("a turn ended during a sync: %d runs and err %v, want 2 and none", runs, err)
	}
	// With the note older than the sync, one run is enough.
	if runs = 0; syncQueued(dir, func() error { runs++; return nil }) != nil || runs != 1 {
		t.Errorf("nothing ended during the sync: %d runs, want 1", runs)
	}

	// While another sync holds the lock, this one leaves it to that one.
	os.WriteFile(lock, nil, 0o600)
	if runs = 0; syncQueued(dir, func() error { runs++; return nil }) != nil || runs != 0 {
		t.Errorf("another sync was running: %d runs, want none", runs)
	}
	// A lock left by a sync that died is taken over.
	long := time.Now().Add(-2 * syncLockStale)
	os.Chtimes(lock, long, long)
	failed := errors.New("no network")
	if err := syncQueued(dir, func() error { runs++; return failed }); err != failed || runs != 1 {
		t.Errorf("a stale lock: %d runs and err %v, want 1 and the sync's error", runs, err)
	}
	if _, err := os.Stat(lock); err == nil {
		t.Error("a failed sync left its lock behind")
	}
}
