package sources

import (
	"encoding/json"
	"io"
	"strings"

	"github.com/part-avocado/helios/internal/timeline"
)

func ClaudeParser() Parser {
	counted := map[string]bool{}
	return func(r io.Reader, id string) (Raw, error) {
		out := Raw{Tool: "claude-code", ID: id}
		err := lines(r, func(b []byte) {
			var rec claudeRecord
			if json.Unmarshal(b, &rec) != nil || (rec.Type != "user" && rec.Type != "assistant") {
				return
			}
			t, ok := parseTime(rec.Timestamp)
			if !ok {
				return
			}
			if out.Cwd == "" {
				out.Cwd = rec.Cwd
			}
			if rec.IsSidechain {
				return
			}
			if rec.SessionID != "" {
				out.ID = rec.SessionID
			}
			var msg struct {
				ID      string          `json:"id"`
				Content json.RawMessage `json:"content"`
				Usage   struct {
					Input       int64 `json:"input_tokens"`
					CacheCreate int64 `json:"cache_creation_input_tokens"`
					CacheRead   int64 `json:"cache_read_input_tokens"`
					Output      int64 `json:"output_tokens"`
				} `json:"usage"`
			}
			json.Unmarshal(rec.Message, &msg)
			ev := timeline.Event{Time: t, Kind: timeline.Agent}

			if rec.Type == "assistant" {
				key := msg.ID + "\x00" + rec.RequestID
				if u := msg.Usage; key != "\x00" && !counted[key] {
					counted[key] = true
					ev.In, ev.Out = u.Input+u.CacheCreate+u.CacheRead, u.Output
				}
				var edit Edit
				var calls []struct {
					Type  string          `json:"type"`
					ID    string          `json:"id"`
					Name  string          `json:"name"`
					Input json.RawMessage `json:"input"`
				}
				json.Unmarshal(msg.Content, &calls)
				for _, c := range calls {
					if c.Type != "tool_use" || counted["tool\x00"+c.ID] {
						continue
					}
					if e, ok := claudeEdit(c.Name, c.Input); ok {
						if c.ID != "" {
							counted["tool\x00"+c.ID] = true
						}
						edit.merge(e)
					}
				}
				out.addAgent(ev, edit)
				return
			}
			text, human := rec.prompt(msg.Content)
			if !human {
				out.Events = append(out.Events, ev)
				return
			}
			ev.Kind = timeline.Human
			out.addPrompt(ev, text)
		})
		return out, err
	}
}

type claudeRecord struct {
	Type             string          `json:"type"`
	Timestamp        string          `json:"timestamp"`
	Cwd              string          `json:"cwd"`
	SessionID        string          `json:"sessionId"`
	RequestID        string          `json:"requestId"`
	IsMeta           bool            `json:"isMeta"`
	IsSidechain      bool            `json:"isSidechain"`
	IsCompactSummary bool            `json:"isCompactSummary"`
	Origin           json.RawMessage `json:"origin"`
	Message          json.RawMessage `json:"message"`
}

func (rec claudeRecord) prompt(content json.RawMessage) (string, bool) {
	var origin struct {
		Kind string `json:"kind"`
	}
	hasOrigin := len(rec.Origin) > 0 && string(rec.Origin) != "null" && json.Unmarshal(rec.Origin, &origin) == nil
	text, typed := typedText(content)
	human := !rec.IsMeta && !rec.IsSidechain && !rec.IsCompactSummary &&
		((hasOrigin && origin.Kind == "human") || (!hasOrigin && typed))
	return text, human
}

var injected = []string{
	"<task-notification>", "<teammate-message", "Another Claude session sent a message",
	"<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>",
	"<bash-stdout>", "<bash-stderr>", "<system-reminder>",
}

func typedText(content json.RawMessage) (string, bool) {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s, !isInjected(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &blocks) != nil {
		return "", false
	}
	var parts []string
	typed := false
	for _, b := range blocks {
		switch {
		case b.Type == "text" && !isInjected(b.Text):
			parts, typed = append(parts, b.Text), true
		case b.Type == "image":
			typed = true
		}
	}
	return strings.Join(parts, "\n"), typed
}

func isInjected(s string) bool {
	return strings.TrimSpace(s) == "" || Injected(s)
}

func Injected(s string) bool {
	s = strings.TrimSpace(s)
	for _, p := range injected {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
