package main

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// TestMain runs the tests outside any repository a shell or git hook named,
// so the git repositories they make are their own, and git never writes to
// that one.
func TestMain(m *testing.M) {
	for _, v := range []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"} {
		os.Unsetenv(v)
	}
	os.Exit(m.Run())
}

// Every command main dispatches is in the help, except the ones tools run,
// so the help can't go stale when a command is added.
func TestUsageListsEveryCommand(t *testing.T) {
	hidden := map[string]bool{"hook": true, "relay": true, "help": true, "version": true}
	f, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var commands []string
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "main" {
			continue
		}
		ast.Inspect(fn, func(n ast.Node) bool {
			if c, ok := n.(*ast.CaseClause); ok {
				for _, e := range c.List {
					if lit, ok := e.(*ast.BasicLit); ok && lit.Kind == token.STRING {
						s, _ := strconv.Unquote(lit.Value)
						commands = append(commands, s)
					}
				}
			}
			return true
		})
	}
	if len(commands) < 5 {
		t.Fatalf("found only %v in main's switch", commands)
	}
	for _, c := range commands {
		if !hidden[c] && !strings.Contains(usage, "teardrop "+c+" ") {
			t.Errorf("usage does not list %q", c)
		}
	}
	if strings.Contains(usage, "teardrop server") {
		t.Error("usage lists the retired review server")
	}
}

// The report says how many prompts each check skipped, across projects,
// and names only the checks that skipped any.
func TestReportSaysWhyPromptsWereSkipped(t *testing.T) {
	rep := timeline.Report{Projects: []timeline.ProjectTotal{
		{Project: timeline.Project{Name: "game"}, Prompts: 9, NoisePrompts: 2, AutopilotPrompts: 1},
		{Project: timeline.Project{Name: "site"}, Prompts: 4, NoisePrompts: 1, RepeatPrompts: 3},
	}}
	var out bytes.Buffer
	printReport(&out, rep, 2)
	for _, want := range []string{
		"7 prompts earned no time (SKIPPED):\n",
		"  3 read as keyboard mashing rather than writing\n",
		"  3 asked again for something already asked twice in the last 5 prompts\n",
		"  1 only steered (\"continue\", \"yes\", \"fix it\") after two such prompts in a row\n",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("report lacks %q:\n%s", want, &out)
		}
	}

	rep.Projects = []timeline.ProjectTotal{{Project: timeline.Project{Name: "game"}, Prompts: 9, RepeatPrompts: 1}}
	out.Reset()
	printReport(&out, rep, 1)
	if s := out.String(); !strings.Contains(s, "1 prompt earned no time") || strings.Contains(s, "mashing") || strings.Contains(s, "steered") {
		t.Errorf("with only a repeat skipped:\n%s", s)
	}
	rep.Projects[0].RepeatPrompts = 0
	out.Reset()
	printReport(&out, rep, 1)
	if strings.Contains(out.String(), "earned no time") {
		t.Errorf("with nothing skipped:\n%s", &out)
	}
}

func TestFolderKey(t *testing.T) {
	home := filepath.Join(t.TempDir(), "ada")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // Windows
	for _, c := range []struct{ root, want string }{
		{filepath.Join(home, "code", "app"), "~/code/app"},
		{home, "home"},
		// A folder whose name starts like the home folder's is not in it.
		{home + "2", home + "2"},
		{filepath.Dir(home), filepath.Dir(home)},
	} {
		if got := folderKey(c.root); got != c.want {
			t.Errorf("folderKey(%q) = %q, want %q", c.root, got, c.want)
		}
	}
	// A project with a remote is still keyed by it.
	if p := nameProject(filepath.Join(home, "code", "app"), "git@github.com:Kid/App.git"); p.Key != "github.com/kid/app" {
		t.Errorf("remote project key %q", p.Key)
	}
	// A remote that is a folder on this computer is keyed like a folder, so it doesn't name the home folder either.
	repos := filepath.Join(home, "repos", "x.git")
	for _, remote := range []string{repos, "file://" + filepath.ToSlash(repos)} {
		if p := nameProject(filepath.Join(home, "code", "x"), remote); p.Key != "~/repos/x" || p.Name != "x" {
			t.Errorf("remote %q: key %q, name %q", remote, p.Key, p.Name)
		}
	}
	// A remote of the home folder itself is named home, not after the account;
	// one that climbs out of home names no folder of this computer's.
	if p := nameProject("", "~/"); p.Key != "home" || p.Name != "home" {
		t.Errorf("remote ~/ became %q, %q", p.Key, p.Name)
	}
	if p := nameProject("", "~/../x"); strings.Contains(p.Key, filepath.ToSlash(filepath.Dir(home))) || strings.HasPrefix(p.Key, "/") {
		t.Errorf("remote ~/../x became %q, which names a folder outside home", p.Key)
	}
	// A relayed event carries that key, which is used as it is, case and all,
	// and a remote git takes as ~/repos/x.git is the same folder.
	for _, remote := range []string{"~/Repos/X", "~/Repos/X.git"} {
		if p := nameProject("", remote); p.Key != "~/Repos/X" || p.Name != "X" {
			t.Errorf("remote %q became %q, %q", remote, p.Key, p.Name)
		}
	}
}
