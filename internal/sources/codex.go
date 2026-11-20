package sources

import (
	"encoding/json"
	"io"
	"strings"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// ParseCodex reads a Codex CLI rollout (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl,
// archived_sessions, and their .jsonl.zst forms).
//
// A typed prompt is an event_msg/user_message record in legacy rollouts, and
// an event_msg/item_completed record with a UserMessage item in paginated
// rollouts (Codex 0.147 and later). Every other timestamped record after
// session_meta is agent output. Rollouts not started by a person (subagents,
// reviewers) contain no human inputs, since their "user" messages come from
// another agent.
//
// Line changes come from apply_patch calls, whether made as a custom tool
// call, a function call, or a shell command.
//
// Tokens come from token_count events, which carry the session's running
// total; each event is credited with the increase since the previous one, so
// repeated events are not counted twice.
func ParseCodex(r io.Reader, id string) (Raw, error) {
	out := Raw{Tool: "codex", ID: id}
	subagent, seenMeta := false, false
	var lastIn, lastOut int64
	patched := map[string]bool{} // call IDs already counted, since a fork copies its parent's records
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
				return // a fork copies its parent's header later in the file
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
					Input  int64 `json:"input_tokens"` // includes cached input
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

// codexPrompt returns the text of a user_message event or an item_completed
// UserMessage item, and false for any other item.
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
