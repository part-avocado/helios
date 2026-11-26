package sources

import (
	"encoding/json"
	"io"
	"strings"

	"github.com/part-avocado/helios/internal/timeline"
)

func ParseCodex(r io.Reader, id string) (Raw, error) {
	out := Raw{Tool: "codex", ID: id}
	subagent, seenMeta := false, false
	var lastIn, lastOut int64
	patched := map[string]bool{}
	err := lines(r, func(b []byte) {
		var rec struct {
			Timestamp string `json:"timestamp"`
			Type      string `json:"type"`
			Payload   struct {
				Type         string          `json:"type"`
				ID           string          `json:"id"`
				Cwd          string          `json:"cwd"`
				Source       json.RawMessage `json:"source"`
				ThreadSource string          `json:"thread_source"`
				Message      json.RawMessage `json:"message"`
				Item         json.RawMessage `json:"item"`
				Info         json.RawMessage `json:"info"`
				Git          json.RawMessage `json:"git"`
				Name         string          `json:"name"`
				CallID       string          `json:"call_id"`
				Input        string          `json:"input"`
				Arguments    string          `json:"arguments"`
			} `json:"payload"`
		}
		if json.Unmarshal(b, &rec) != nil {
			return
		}
		p := rec.Payload
		switch rec.Type {
		case "session_meta":
			if seenMeta {
				return
			}
			seenMeta = true
			var git struct {
				RepositoryURL string `json:"repository_url"`
			}
			json.Unmarshal(p.Git, &git)
			out.Cwd, out.GitURL = p.Cwd, git.RepositoryURL
			if p.ID != "" {
				out.ID = p.ID
			}
			var src string
			subagent = (p.ThreadSource != "" && p.ThreadSource != "user") || (len(p.Source) > 0 && json.Unmarshal(p.Source, &src) != nil)
			return
		case "turn_context":
			if p.Cwd != "" {
				out.Cwd = p.Cwd
			}
		}
		t, ok := parseTime(rec.Timestamp)
		if !ok {
			return
		}
		ev := timeline.Event{Time: t, Kind: timeline.Agent}
		if rec.Type == "response_item" && (p.Type == "custom_tool_call" || p.Type == "function_call") && !patched[p.CallID] {
			if patch, ok := findPatch(p.Input + p.Arguments); ok {
				if p.CallID != "" {
					patched[p.CallID] = true
				}
				out.addAgent(ev, patchEdit(patch))
				return
			}
		}
		if rec.Type != "event_msg" {
			out.Events = append(out.Events, ev)
			return
		}
		switch p.Type {
		case "token_count":
			var info struct {
				Total struct {
					Input  int64 `json:"input_tokens"`
					Output int64 `json:"output_tokens"`
				} `json:"total_token_usage"`
			}
			if json.Unmarshal(p.Info, &info) == nil && (info.Total.Input > lastIn || info.Total.Output > lastOut) {
				ev.In, ev.Out = max(0, info.Total.Input-lastIn), max(0, info.Total.Output-lastOut)
				lastIn, lastOut = info.Total.Input, info.Total.Output
			}
		case "user_message", "item_completed":
			text, ok := codexPrompt(p.Type, p.Message, p.Item)
			if ok && !subagent {
				ev.Kind = timeline.Human
				out.addPrompt(ev, text)
				return
			}
		}
		out.Events = append(out.Events, ev)
	})
	return out, err
}

func codexPrompt(typ string, message, item json.RawMessage) (string, bool) {
	if typ == "user_message" {
		var s string
		json.Unmarshal(message, &s)
		return s, true
	}
	var it struct {
		Type    string `json:"type"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(item, &it) != nil && it.Type == "" {
		return "", false
	}
	if it.Type != "UserMessage" {
		return "", false
	}
	var parts []string
	for _, c := range it.Content {
		parts = append(parts, c.Text)
	}
	return strings.Join(parts, "\n"), true
}
