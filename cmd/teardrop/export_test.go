package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// The dashboard trusts a report only if Key verifies over Payload with the
// account inside Payload. Check that contract the way the dashboard does.
func TestSignReport(t *testing.T) {
	t.Setenv("TEARDROP_DATA_DIR", t.TempDir())
	now := time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC)
	rep := timeline.Report{Engaged: timeline.Seconds(90 * time.Minute)}

	verify := func(s SignedReport) (exportPayload, bool) {
		var p exportPayload
		if json.Unmarshal([]byte(s.Payload), &p) != nil {
			return p, false
		}
		pub, _ := base64.RawURLEncoding.DecodeString(p.Account)
		sig, _ := base64.RawURLEncoding.DecodeString(s.Key)
		return p, len(pub) == ed25519.PublicKeySize && ed25519.Verify(pub, []byte(s.Payload), sig)
	}

	a, err := signReport(rep, "30d", now)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := verify(a)
	if !ok || !strings.Contains(a.Payload, `"engaged_seconds":5400`) || !p.GeneratedAt.Equal(now) || !p.ExpiresAt.Equal(now.Add(keyLifetime)) {
		t.Fatalf("fresh export did not verify or lost data: ok=%v %+v", ok, p)
	}

	// Later exports reuse the same account, and a different time gives a different key.
	b, _ := signReport(rep, "30d", now.Add(time.Minute))
	q, ok := verify(b)
	if !ok || q.Account != p.Account || b.Key == a.Key {
		t.Errorf("second export: ok=%v same account=%v same key=%v", ok, q.Account == p.Account, b.Key == a.Key)
	}

	// Fluffing the hours, or moving the time, breaks the key.
	for _, edit := range [][2]string{{`"engaged_seconds":5400`, `"engaged_seconds":54000`}, {"2026-11-20", "2026-11-27"}} {
		c := a
		c.Payload = strings.Replace(a.Payload, edit[0], edit[1], 1)
		if c.Payload == a.Payload {
			t.Fatalf("edit %q did not apply to %s", edit[0], a.Payload)
		}
		if _, ok := verify(c); ok {
			t.Errorf("edited payload (%s -> %s) still verified", edit[0], edit[1])
		}
	}
}
