package main

import (
	"crypto/ed25519"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/part-avocado/teardrop/internal/sources"
	"github.com/part-avocado/teardrop/internal/timeline"
)

// What `teardrop sync` sends: records, not a report. The site works out the
// hours from them (worker/src/hub.ts) and keeps them in R2.
//
//   - Every journal event, as its hook wrote it. The site already has the
//     ones each hook sent as it happened, and drops a record it is sent twice.
//   - For each transcript turn that no hook saw, such as from before the hooks
//     were set up, a prompt and a turn end at the transcript's times. They
//     reach the site late, so they count as unwitnessed.
//   - For every transcript turn, a usage record with the tokens and lines
//     the transcript shows, which earns no time. It is keyed by the turn's
//     prompt, so sending a growing turn again replaces it.

// A transcript prompt this close to a hook's prompt in the same session is the same prompt.
const sameTurn = 2 * time.Minute

// syncRecords builds the records for transcripts and journal events after
// cutoff. resolve names a log's project; only its key leaves the computer.
func syncRecords(transcripts []sources.Raw, journal []sources.JournalEvent, resolve func(sources.Raw) (timeline.Project, string), cutoff time.Time) []sources.JournalEvent {
	var out []sources.JournalEvent
	type key struct{ tool, session string }
	hooked := map[key][]sources.JournalEvent{}
	// journal may start before cutoff, so a turn that began earlier still finds its hook.
	for _, ev := range journal {
		hooked[key{ev.Tool, ev.Session}] = append(hooked[key{ev.Tool, ev.Session}], ev)
		if !ev.Time.After(cutoff) {
			continue
		}
		p, _ := resolve(sources.Raw{Tool: ev.Tool, ID: ev.Session, Cwd: ev.Cwd, GitURL: ev.Git})
		ev.Git, ev.Cwd = p.Key, ""
		out = append(out, ev)
	}
	for _, r := range transcripts {
		p, _ := resolve(r)
		hooks := hooked[key{r.Tool, r.ID}]
		// hookSaw reports whether a hook recorded a prompt near t, and a turn end after it before the next prompt.
		hookSaw := func(t time.Time) (prompt, end bool) {
			for i, ev := range hooks {
				if !ev.Human || ev.Time.Sub(t).Abs() > sameTurn {
					continue
				}
				for _, later := range hooks[i+1:] {
					if later.Human {
						break
					}
					if k := kindOf(later.Tool, later.Event); k == "turn_end" || k == "session_end" {
						return true, true
					}
				}
				return true, false
			}
			return false, false
		}
		ev := slices.Clone(r.Events)
		idx := make([]int, len(ev)) // where each event sits in r.Events, for its score
		for i := range idx {
			idx[i] = i
		}
		slices.SortStableFunc(idx, func(a, b int) int { return r.Events[a].Time.Compare(r.Events[b].Time) })
		for i, j := range idx {
			ev[i] = r.Events[j]
		}
		base := sources.JournalEvent{Tool: r.Tool, Session: r.ID, Git: p.Key}
		for start := 0; start < len(ev); {
			end := start + 1
			for end < len(ev) && ev[end].Kind != timeline.Human {
				end++
			}
			turn := ev[start:end]
			human := turn[0].Kind == timeline.Human
			at := turn[0].Time
			if turn[len(turn)-1].Time.After(cutoff) {
				prompt, ended := false, false
				if human {
					prompt, ended = hookSaw(at)
				}
				if human && !prompt {
					rec := base
					rec.Time, rec.Event, rec.Human = at, "prompt", true
					if s, ok := r.Scores[idx[start]]; ok {
						rec.Judged, rec.Real, rec.Sim, rec.Low = s.Judged, s.Real, uint64(s.Sim), s.Low
					} else {
						rec.Judged, rec.Real = 1, 1 // a prompt the transcript holds no words of, such as an image
					}
					out = append(out, rec)
				}
				var use sources.JournalEvent
				for _, e := range turn[1:] {
					use.In, use.Out, use.Added, use.Removed = use.In+e.In, use.Out+e.Out, use.Added+e.Added, use.Removed+e.Removed
				}
				if !human {
					use.In, use.Out, use.Added, use.Removed = use.In+turn[0].In, use.Out+turn[0].Out, use.Added+turn[0].Added, use.Removed+turn[0].Removed
				}
				if len(turn) > 1 && !ended {
					rec := base
					rec.Time, rec.Event = turn[len(turn)-1].Time, "turn_end"
					out = append(out, rec)
				}
				if use.In+use.Out > 0 || use.Added+use.Removed > 0 {
					rec := base
					rec.Time, rec.Event = at, "usage"
					rec.In, rec.Out, rec.Added, rec.Removed = use.In, use.Out, use.Added, use.Removed
					out = append(out, rec)
				}
			}
			start = end
		}
	}
	return out
}

// eventsReply is the site's answer to records: how many were new, and how
// many it refused because they say they happened in its future.
type eventsReply struct {
	Records int `json:"records"`
	Future  int `json:"dropped_future"`
}

// sendRecords posts records to the site's events API in batches, as from
// this computer. It returns how many the site took as new, and how many it
// refused as dated in the future.
func sendRecords(client *http.Client, server, key string, lines []byte, header http.Header) (stored, future int, err error) {
	err = sendLines(lines, func(batch []byte) (int, error) {
		var r eventsReply
		status, err := relayRequestWith(client, "POST", server+"/api/v1/events", key, batch, &r, header)
		stored += r.Records
		future += r.Future
		return status, err
	})
	return stored, future, err
}

// account is who a sync key belongs to, as the site's whoami answers.
type account struct {
	Name   string    `json:"name"`
	Handle string    `json:"handle"`
	Time   time.Time `json:"time"` // the site's clock
	// Skew is how far this computer's clock is ahead of the site's; behind is negative.
	Skew time.Duration `json:"-"`
}

// whoami asks the site whose key this is, and its time. It returns the HTTP
// status too: 401 for a key the site doesn't know, 403 for a ban, and 404
// from a site older than whoami.
func whoami(client *http.Client, server, key string) (account, int, error) {
	var who account
	start := time.Now()
	status, err := relayRequest(client, "GET", server+"/api/v1/whoami", key, nil, &who)
	if err != nil {
		return who, status, err
	}
	if who.Time.IsZero() {
		return who, status, fmt.Errorf("the site did not say its time")
	}
	who.Skew = start.Add(time.Since(start) / 2).Sub(who.Time)
	return who, status, nil
}

// clockWarning says what a clock skew does to the person's time, or is ""
// when it is too small to matter. The site refuses records dated more than 5
// minutes ahead of it, and credits only records that reach it within 5
// minutes of when they say they happened.
func clockWarning(skew time.Duration) string {
	off := plural(int(skew.Abs().Round(time.Minute)/time.Minute), "minute")
	if skew.Abs() < 2*time.Minute {
		return ""
	}
	if skew > 0 {
		return fmt.Sprintf("Your clock is %s ahead of the site's. Past 5 minutes ahead, the site refuses your records as dated in the future, and none of your time counts. Set your clock to update automatically.", off)
	}
	return fmt.Sprintf("Your clock is %s behind the site's. Past 5 minutes behind, your records look like they arrived late, so the site keeps them but credits none of their time. Set your clock to update automatically.", off)
}

// computerHeader names this computer and its clock's UTC offset, which decides its records' days.
func computerHeader() (http.Header, error) {
	_, offset := time.Now().Zone()
	header := http.Header{"X-Teardrop-Utc-Offset": {fmt.Sprint(offset / 60)}}
	id, err := thisComputer()
	if err != nil {
		return nil, err
	}
	header.Set("X-Teardrop-Computer", id)
	return header, nil
}

// thisComputer is this install's td- ID, which its reports are signed as too.
func thisComputer() (string, error) {
	priv, err := accountKey()
	if err != nil {
		return "", err
	}
	return accountID(priv.Public().(ed25519.PublicKey)), nil
}
