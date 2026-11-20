package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/part-avocado/teardrop/internal/timeline"
	"github.com/part-avocado/teardrop/site"
)

// runDashboard serves the website's dashboard on this machine, with live data
// from this machine's logs at /api/report, signed like `teardrop export`. It listens on localhost only.
func runDashboard(args []string) {
	fs := flag.NewFlagSet("dashboard", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:7878", "address to listen on (localhost only)")
	noOpen := fs.Bool("no-open", false, "don't open a browser")
	claudeDir := fs.String("claude-dir", "", "Claude Code config directories, comma-separated")
	codexDir := fs.String("codex-dir", "", "Codex home directories, comma-separated")
	fs.Parse(args)

	host, port, err := net.SplitHostPort(*addr)
	check(err)
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		check(fmt.Errorf("-addr %s: the dashboard only listens on localhost, so your stats stay on this machine", *addr))
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServerFS(site.FS))
	mux.HandleFunc("/api/report", func(w http.ResponseWriter, r *http.Request) {
		since := r.URL.Query().Get("since")
		if since == "" {
			since = "30d"
		}
		window, err := parseSince(since)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		now := time.Now()
		raws, _ := loadAll(*claudeDir, *codexDir)
		rep, _ := buildReport(raws, now.Add(-window), timeline.DefaultRules)
		signed, err := signReport(rep, since, now)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(signed)
	})

	ln, err := net.Listen("tcp", *addr)
	check(err)
	url := "http://localhost:" + port + "/dashboard.html"
	fmt.Println("teardrop dashboard:", url)
	fmt.Println("It updates every 30 seconds. Press Ctrl+C to stop.")
	if !*noOpen {
		openBrowser(url)
	}
	check(http.Serve(ln, localOnly(mux)))
}

// localOnly refuses requests whose Host is not localhost, so a web page that
// rebinds its own domain to 127.0.0.1 can't read your stats.
func localOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Stdout, cmd.Stderr = nil, nil
	if cmd.Start() != nil {
		fmt.Fprintln(os.Stderr, "Open the link above in your browser.")
	}
}
