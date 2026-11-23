package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"
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
