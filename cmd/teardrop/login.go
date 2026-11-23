package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// runLogin connects this computer to an account on a teardrop site without
// copying a key: it shows a code to type on the site, waits until it is
// allowed there, remembers the sync key it gets, and syncs once.
func runLogin(args []string) {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	server := fs.String("server", "", "your teardrop site, such as https://teardrop.example.org, remembered for later runs")
	noOpen := fs.Bool("no-open", false, "don't open a browser")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: teardrop login -server https://your-site")
		fmt.Fprintln(os.Stderr, "       Connects this computer to your account: type the code it shows on the site.")
		fmt.Fprintln(os.Stderr)
		fs.PrintDefaults()
	}
	fs.Parse(args)
	srv, err := serverURL(*server)
	if err != nil && *server == "" {
		check(errors.New("name your teardrop site: teardrop login -server https://your-site"))
	}
	check(err)
	id, err := thisComputer()
	check(err)
	open := openBrowser
	if *noOpen {
		open = func(string) {}
	}
	key, name, err := login(&http.Client{Timeout: 15 * time.Second}, srv, id, os.Stdout, open)
	check(err)
	_, err = syncKey(key, srv)
	check(err)
	fmt.Printf("Connected to %s's account on %s.\n\n", name, srv)
	runSync(nil)
	fmt.Println("\nRun `teardrop doctor` any time to check that your time is reaching the site.")
}

// login asks srv to connect computer, tells the person on out what to type
// where, and waits until they allow or cancel it. It returns the sync key
// and whose account it is.
func login(client *http.Client, srv, computer string, out io.Writer, open func(string)) (key, name string, err error) {
	body, _ := json.Marshal(map[string]string{"computer": computer})
	res, err := client.Post(srv+"/api/v1/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", "", fmt.Errorf("could not reach %s: %w", srv, err)
	}
	var start struct {
		Code      string `json:"code"`
		UserCode  string `json:"user_code"`
		URL       string `json:"url"`
		ExpiresIn int    `json:"expires_in"`
		Interval  int    `json:"interval"`
	}
	err = answer(res, &start)
	if res.StatusCode == http.StatusNotFound {
		return "", "", fmt.Errorf("%s has no `teardrop login` yet; copy the command under Settings, Setup on it instead", srv)
	}
	if err != nil {
		return "", "", err
	}
	if u, perr := url.Parse(start.URL); perr != nil || !strings.HasPrefix(start.URL, srv+"/") || u.Host == "" {
		return "", "", fmt.Errorf("%s answered with a page that isn't its own (%q)", srv, start.URL)
	}
	fmt.Fprintf(out, "To connect this computer (%s) to your account, open\n\n    %s\n\nand type this code:\n\n    %s\n\nWaiting for you to allow it there... (Ctrl+C to stop)\n\n", computer, start.URL, start.UserCode)
	open(start.URL)

	every := time.Duration(max(start.Interval, 1)) * time.Second
	deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(every)
		res, err := client.Get(srv + "/api/v1/login/" + url.PathEscape(start.Code))
		if err != nil {
			continue // a dropped connection is no answer; ask again
		}
		var poll struct {
			Status string `json:"status"`
			Key    string `json:"key"`
			Name   string `json:"name"`
		}
		if err := answer(res, &poll); err != nil {
			return "", "", err
		}
		switch poll.Status {
		case "done":
			if !strings.HasPrefix(poll.Key, "tdk_") {
				return "", "", fmt.Errorf("%s sent a key teardrop doesn't recognize", srv)
			}
			return poll.Key, poll.Name, nil
		case "denied":
			return "", "", errors.New("not connected: it was cancelled on the site")
		}
	}
	return "", "", errors.New("not connected: the code expired before it was allowed. Run `teardrop login` again")
}

// answer decodes a JSON answer into out, or returns the site's refusal, which is plain text.
func answer(res *http.Response, out any) error {
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode/100 != 2 {
		if msg := strings.TrimSpace(string(b)); msg != "" && !strings.HasPrefix(msg, "<") {
			return errors.New(msg) // the site's refusal, in its own words
		}
		return fmt.Errorf("the site answered %s", res.Status)
	}
	return json.Unmarshal(b, out)
}
