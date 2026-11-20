package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// commands lists each event's hook commands, in order.
func commands(t *testing.T, raw json.RawMessage) map[string][]string {
	var hooks map[string][]struct {
		Matcher string `json:"matcher"`
		Hooks   []struct {
			Command string `json:"command"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(raw, &hooks); err != nil {
		t.Fatal(err)
	}
	out := map[string][]string{}
	for ev, groups := range hooks {
		for _, g := range groups {
			for _, h := range g.Hooks {
				out[ev] = append(out[ev], g.Matcher+"|"+h.Command)
			}
		}
	}
	return out
}

func TestSetHooks(t *testing.T) {
	user := `{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}],"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"check.sh"}]}]}`
	settings := map[string]json.RawMessage{"theme": json.RawMessage(`"dark"`), "hooks": json.RawMessage(user)}
	old := `"/opt/teardrop" hook claude-code`

	if changed, err := setHooks(settings, old, true); err != nil || !changed {
		t.Fatalf("install: changed %v err %v", changed, err)
	}
	got := commands(t, settings["hooks"])
	if strings.Join(got["Stop"], ",") != "|say done,|"+old || strings.Join(got["PreToolUse"], ",") != "Bash|check.sh" ||
		len(got["UserPromptSubmit"]) != 1 || len(got["SessionStart"]) != 1 || len(got["SessionEnd"]) != 1 {
		t.Fatalf("after install: %v", got)
	}
	if changed, _ := setHooks(settings, old, true); changed {
		t.Error("rerunning setup changed the settings again")
	}

	// A moved binary replaces the old hooks instead of adding more.
	moved := `"C:/Users/kid/AppData/Local/Programs/teardrop/teardrop.exe" hook claude-code`
	if changed, _ := setHooks(settings, moved, true); !changed {
		t.Error("new path not applied")
	}
	n := 0
	for _, cmds := range commands(t, settings["hooks"]) {
		for _, c := range cmds {
			if strings.Contains(c, "/opt/teardrop") {
				t.Errorf("old hook left behind: %s", c)
			}
			if strings.Contains(c, "teardrop.exe") {
				n++
			}
		}
	}
	if n != len(hookEvents) {
		t.Errorf("%d teardrop hooks, want %d", n, len(hookEvents))
	}

	// Removing restores exactly the user's own hooks.
	if changed, _ := setHooks(settings, "", false); !changed || !sameJSON(settings["hooks"], json.RawMessage(user)) {
		t.Errorf("after removal: %s", settings["hooks"])
	}
	if string(settings["theme"]) != `"dark"` {
		t.Error("unrelated setting changed")
	}

	if _, err := setHooks(map[string]json.RawMessage{"hooks": json.RawMessage(`[1]`)}, old, true); err == nil {
		t.Error("an unrecognized hooks shape was overwritten instead of refused")
	}
}

func TestRenderAmpPlugin(t *testing.T) {
	got := string(renderAmpPlugin(`C:\Users\kid\AppData\Local\Programs\teardrop\teardrop.exe`))
	if !strings.Contains(got, `const teardrop = "C:\\Users\\kid\\AppData\\Local\\Programs\\teardrop\\teardrop.exe"`) || strings.Contains(got, "__TEARDROP_PATH__") {
		t.Errorf("path not filled in as a string literal:\n%s", got)
	}
	if !strings.HasPrefix(got, ampPluginMarker) {
		t.Error("rendered plugin lacks the marker that setup uses to recognize it")
	}
}
