package main

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// Every command main dispatches is in the help, except the ones tools and
// superadmins run, so the help can't go stale when a command is added.
func TestUsageListsEveryCommand(t *testing.T) {
	hidden := map[string]bool{"hook": true, "relay": true, "export-records": true, "help": true, "version": true}
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
