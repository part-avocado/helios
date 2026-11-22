package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadOldRecords(t *testing.T) {
	dir := t.TempDir()
	for id, rec := range map[string]string{
		"b": `{"id":"b","account":"td-0123456789ab","project":{"key":"github.com/kid/site","name":"site"},"received_at":"2026-10-02T00:00:00Z","engaged":[{"start":"2026-10-01T10:00:00Z","end":"2026-10-01T11:00:00Z"}],"credited_seconds":3600}`,
		"a": `{"id":"a","account":"td-0123456789ab","project":{"key":"github.com/kid/site","name":"site"},"received_at":"2026-09-01T00:00:00Z","credited_seconds":60}`,
	} {
		os.MkdirAll(filepath.Join(dir, "submissions", id), 0o700)
		os.WriteFile(filepath.Join(dir, "submissions", id, "record.json"), []byte(rec), 0o600)
	}
	recs, err := readOldRecords(dir)
	if err != nil || len(recs) != 2 || recs[0].ID != "a" || recs[1].Credited != 3600*1e9 || len(recs[1].Engaged) != 1 {
		t.Fatalf("got %+v, %v", recs, err)
	}
}
