package timeline

import (
	"math/rand"
	"testing"
	"time"
)

func randomSession(r *rand.Rand, n int) []Event {
	t := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	ev := make([]Event, n)
	for i := range ev {
		t = t.Add(time.Duration(r.Int63n(int64(time.Hour))))
		k := Agent
		if r.Intn(3) == 0 {
			k = Human
		}
		ev[i] = Event{Time: t, Kind: k}
	}
	return ev
}

func TestCreditProperties(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 2000; i++ {
		ev := randomSession(r, 2+r.Intn(30))
		got := Total(Credit(ev, DefaultRules))
		if span := ev[len(ev)-1].Time.Sub(ev[0].Time); got > span {
			t.Fatalf("engaged %v exceeds the session's span %v", got, span)
		}
		if limit := time.Duration(len(ev)-1) * max(DefaultRules.ComposeCap, DefaultRules.WatchCap); got > limit {
			t.Fatalf("engaged %v exceeds %v", got, limit)
		}
		shuffled := append([]Event(nil), ev...)
		r.Shuffle(len(shuffled), func(a, b int) { shuffled[a], shuffled[b] = shuffled[b], shuffled[a] })
		if again := Total(Credit(shuffled, DefaultRules)); again != got {
			t.Fatalf("shuffled events gave %v, want %v", again, got)
		}
		if twice := Total(Union(append(Credit(ev, DefaultRules), Credit(ev, DefaultRules)...))); twice != got {
			t.Fatalf("a session run twice in parallel gave %v, want %v", twice, got)
		}
		more := DefaultRules
		more.ComposeCap += time.Duration(r.Int63n(int64(10 * time.Minute)))
		more.WatchCap += time.Duration(r.Int63n(int64(10 * time.Minute)))
		more.WatchFull = min(more.WatchFull+time.Duration(r.Int63n(int64(time.Minute))), more.WatchCap)
		if higher := Total(Credit(ev, more)); higher < got {
			t.Fatalf("raising the caps to %v/%v lowered %v to %v", more.ComposeCap, more.WatchCap, got, higher)
		}
	}
}
