package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// login shows the code and the site's own page, waits while the login is
// pending, and returns the key once it is allowed; anything else is an
// error that says what happened.
func TestLogin(t *testing.T) {
	cases := []struct {
		name    string
		url     string   // the page the site says to open; "" for its own /connect
		polls   []string // the site's answers to each poll, in order
		key     string
		wantErr string
		polls3  bool // it takes three polls, not two
	}{
		{name: "allowed after a wait", polls: []string{`{"status":"pending"}`, `{"status":"done","key":"tdk_abc","name":"Ada"}`}, key: "tdk_abc"},
		// A site that hiccups while the person types is asked again.
		{name: "a 502 and a 429 on the way", polls: []string{"502 Bad gateway", "429 Slow down", `{"status":"done","key":"tdk_abc","name":"Ada"}`}, key: "tdk_abc", polls3: true},
		{name: "cancelled", polls: []string{`{"status":"denied"}`}, wantErr: "cancelled on the site"},
		{name: "refused", polls: []string{"410 That login has expired or was used already."}, wantErr: "That login has expired"},
		{name: "a page elsewhere", url: "https://evil.example/connect", wantErr: "isn't its own"},
		{name: "a site without login", url: "404", wantErr: "no `helios login` yet"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			var polled atomic.Int32
			var computer string
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == "POST" && r.URL.Path == "/api/v1/login":
					if c.url == "404" {
						http.NotFound(w, r)
						return
					}
					var b struct{ Computer string }
					json.NewDecoder(r.Body).Decode(&b)
					computer = b.Computer
					page := c.url
					if page == "" {
						page = "http://" + r.Host + "/connect"
					}
					fmt.Fprintf(w, `{"code":"tdl_secret","user_code":"BCDF-GH23","url":%q,"expires_in":30,"interval":1}`, page)
				case r.URL.Path == "/api/v1/login/tdl_secret":
					a := c.polls[min(int(polled.Add(1))-1, len(c.polls)-1)]
					if code, msg, ok := strings.Cut(a, " "); ok && (code == "410" || code == "502" || code == "429") {
						status := map[string]int{"410": http.StatusGone, "502": http.StatusBadGateway, "429": http.StatusTooManyRequests}[code]
						http.Error(w, msg, status)
						return
					}
					io.WriteString(w, a)
				default:
					http.NotFound(w, r)
				}
			}))
			defer ts.Close()
			var out bytes.Buffer
			opened := ""
			key, name, err := login(ts.Client(), ts.URL, "td-abcdef012345", &out, func(u string) { opened = u })
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("err %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil || key != c.key || name != "Ada" {
				t.Fatalf("got %q %q %v", key, name, err)
			}
			if computer != "td-abcdef012345" || opened != ts.URL+"/connect" || !strings.Contains(out.String(), "BCDF-GH23") || strings.Contains(out.String(), "tdl_secret") {
				t.Errorf("computer %q, opened %q, printed:\n%s", computer, opened, &out)
			}
			if want := map[bool]int32{false: 2, true: 3}[c.polls3]; polled.Load() != want {
				t.Errorf("polled %d times, want %d", polled.Load(), want)
			}
		})
	}
}
