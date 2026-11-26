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

// runLogin connects this computer to an account on a helios site without
// copying a key: it shows a code to type on the site, waits until it is
// allowed there, remembers the sync key it gets, and syncs once.
func runLogin(args []string) {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	server := fs.String("server", "", txtFlagLoginServer)
	noOpen := fs.Bool("no-open", false, txtFlagNoOpen)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, txtLoginUsage)
		fs.PrintDefaults()
	}
	fs.Parse(args)
	// A new -server is saved only once the login works: saving it forgets
	// the key of the site this computer is connected to now.
	var srv string
	var err error
	if *server != "" {
		srv, err = checkServer(*server)
	} else if srv, err = serverURL(""); err != nil {
		err = errors.New(txtLoginNameSite)
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
	if *server != "" {
		_, err = serverURL(*server)
		check(err)
	}
	_, err = syncKey(key, srv)
	check(err)
	fmt.Printf(txtLoginConnected, name, srv)
	if env := os.Getenv("HELIOS_KEY"); env != "" && env != key {
		// syncKey reads the environment first, so the key just saved would go unused.
		check(errors.New(txtLoginEnvKey))
	}
	runSync(nil)
	fmt.Print(txtLoginDoctorTip)
}

// login asks srv to connect computer, tells the person on out what to type
// where, and waits until they allow or cancel it. It returns the sync key
// and whose account it is.
func login(client *http.Client, srv, computer string, out io.Writer, open func(string)) (key, name string, err error) {
	body, _ := json.Marshal(map[string]string{"computer": computer})
	res, err := client.Post(srv+"/api/v1/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", "", fmt.Errorf(txtCouldNotReach, srv, err)
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
		return "", "", fmt.Errorf(txtLoginNoLogin, srv)
	}
	if err != nil {
		return "", "", err
	}
	if u, perr := url.Parse(start.URL); perr != nil || !strings.HasPrefix(start.URL, srv+"/") || u.Host == "" {
		return "", "", fmt.Errorf(txtLoginBadPage, srv, start.URL)
	}
	fmt.Fprintf(out, txtLoginPrompt, computer, start.URL, start.UserCode)
	open(start.URL)

	every := time.Duration(max(start.Interval, 1)) * time.Second
	deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(every)
		res, err := client.Get(srv + "/api/v1/login/" + url.PathEscape(start.Code))
		if err != nil {
			continue // a dropped connection is no answer; ask again
		}
		// A site that is briefly down or busy is no answer either; one that refuses (4xx) is.
		if res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests {
			res.Body.Close()
			continue
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
				return "", "", fmt.Errorf(txtLoginBadKey, srv)
			}
			return poll.Key, poll.Name, nil
		case "denied":
			return "", "", errors.New(txtLoginDenied)
		}
	}
	return "", "", errors.New(txtLoginExpired)
}

// answer decodes a JSON answer into out, or returns the site's refusal, which is plain text.
func answer(res *http.Response, out any) error {
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode/100 != 2 {
		if msg := strings.TrimSpace(string(b)); msg != "" && !strings.HasPrefix(msg, "<") {
			return errors.New(msg) // the site's refusal, in its own words
		}
		return fmt.Errorf(txtSiteAnswered, res.Status)
	}
	return json.Unmarshal(b, out)
}
