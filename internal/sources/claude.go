package sources

import (
	"encoding/json"
	"io"
	"strings"

	"github.com/part-avocado/teardrop/internal/timeline"
)

// ClaudeParser returns a parser for Claude Code transcripts
// (<config>/projects/<dir>/<session>.jsonl, and subagent transcripts under
// <session>/subagents/). Parsers from one call share state, so token usage
// that a resumed or forked session copies into another file counts once.
//
// Many "user" records are not typed by the person: tool results, harness
// injections, compaction summaries, background task notices, messages from
// other agents, and command output. Those count as agent activity. Newer
// versions tag real prompts with origin.kind "human"; older ones are
// classified by their content.
func ClaudeParser() Parser {
	counted := map[string]bool{} // message IDs whose usage was counted
	return func(r io.Reader, id string) (Raw, error) {
		out := Raw{Tool: "claude-code", ID: id}
		err := lines(r, func(b []byte) {
			// Fields that vary in shape between versions stay raw, so a
			// surprising value drops only that field, not the record.
			var rec struct {
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
			if rec.SessionID != "" && !rec.IsSidechain {
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
				// One response is written as several records, each repeating its usage.
				key := msg.ID + "\x00" + rec.RequestID
				if u := msg.Usage; key != "\x00" && !counted[key] {
					counted[key] = true
					ev.In, ev.Out = u.Input+u.CacheCreate+u.CacheRead, u.Output
				}
				out.Events = append(out.Events, ev)
				return
			}
			var origin struct {
				Kind string `json:"kind"`
			}
			hasOrigin := len(rec.Origin) > 0 && string(rec.Origin) != "null" && json.Unmarshal(rec.Origin, &origin) == nil
			text, typed := typedText(msg.Content)
			human := !rec.IsMeta && !rec.IsSidechain && !rec.IsCompactSummary &&
				((hasOrigin && origin.Kind == "human") || (!hasOrigin && typed))
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

// Prefixes of user-role text that Claude Code writes on its own.
var injected = []string{
	"<task-notification>", "<teammate-message", "Another Claude session sent a message",
	"<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>",
	"<bash-stdout>", "<bash-stderr>", "<system-reminder>",
}

// typedText returns the typed text of message content (a string, or an array
// of blocks) and whether a person typed any of it. Content with a text or
// image block that is not injected text is typed; tool_result blocks alone are not.
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
	s = strings.TrimSpace(s)
	for _, p := range injected {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return s == ""
}
