package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// The Go review server, which teardrop v0.6 and before submitted chat logs
// to, is retired: submissions are made on the website from the records it
// holds. What the review server credited moves to the website, so a project
// is still never credited twice:
//
//	teardrop export-records -data /data > records.jsonl
//
// then a superadmin posts records.jsonl to /api/review/import.

// oldRecord is a review server's record.json: what one submission was credited.
type oldRecord struct {
	ID             string              `json:"id"`
	Account        string              `json:"account"` // the submitting computer's td- ID
	Project        timeline.Project    `json:"project"`
	ReceivedAt     time.Time           `json:"received_at"`
	Claimed        timeline.Seconds    `json:"claimed_seconds"`
	Recomputed     timeline.Seconds    `json:"recomputed_seconds"`
	Engaged        []timeline.Interval `json:"engaged"`
	Earlier        []timeline.Interval `json:"earlier,omitempty"`
	EarlierOverlap timeline.Seconds    `json:"earlier_overlap_seconds"`
	Credited       timeline.Seconds    `json:"credited_seconds"`
}

// readOldRecords reads every submission record in a review server's data folder, oldest first.
func readOldRecords(dir string) ([]oldRecord, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "submissions", "*", "record.json"))
	if err != nil {
		return nil, err
	}
	var out []oldRecord
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		var rec oldRecord
		if err := json.Unmarshal(b, &rec); err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ReceivedAt.Before(out[j].ReceivedAt) })
	return out, nil
}

func runExportRecords(args []string) {
	fs := flag.NewFlagSet("export-records", flag.ExitOnError)
	dir := fs.String("data", "teardrop-data", "the review server's data folder")
	fs.Parse(args)
	recs, err := readOldRecords(*dir)
	check(err)
	enc := json.NewEncoder(os.Stdout)
	for _, r := range recs {
		check(enc.Encode(r))
	}
	fmt.Fprintf(os.Stderr, "%s. Post this to /api/review/import as a superadmin.\n", plural(len(recs), "submission record"))
}
