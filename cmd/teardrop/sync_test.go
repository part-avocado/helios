package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
