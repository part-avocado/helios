package sources

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Message is one entry of a chat as a reviewer reads it.
type Message struct {
	Time time.Time
	Role string // "you" for a person's prompt, "agent" for a reply, "tool" for a tool call
	Text string
}

// toolTextLimit is how much of a tool call's input a transcript shows.
const toolTextLimit = 3000

// Transcript reads the conversation in a log: the person's prompts, the
// agent's replies, and its tool calls. tool is "claude-code", "codex", or
// "journal"; a journal holds no text, so its prompts show only their time.
func Transcript(tool string, data []byte) []Message {
	var out []Message
	add := func(ts, role, text string) {
		if t, ok := parseTime(ts); ok && strings.TrimSpace(text) != "" {
			out = append(out, Message{Time: t, Role: role, Text: text})
		}
	}
	switch tool {
	case "claude-code":
		lines(bytes.NewReader(data), func(b []byte) {
			var rec claudeRecord
			if json.Unmarshal(b, &rec) != nil {
				return
			}
			var msg struct {
				Content json.RawMessage `json:"content"`
			}
			json.Unmarshal(rec.Message, &msg)
			switch rec.Type {
			case "user":
				if text, human := rec.prompt(msg.Content); human {
					add(rec.Timestamp, "you", or(text, "(image)"))
				}
			case "assistant":
				var blocks []struct {
					Type  string          `json:"type"`
					Text  string          `json:"text"`
					Name  string          `json:"name"`
					Input json.RawMessage `json:"input"`
				}
				json.Unmarshal(msg.Content, &blocks)
				for _, bl := range blocks {
					switch bl.Type {
					case "text":
						add(rec.Timestamp, "agent", bl.Text)
					case "tool_use":
						add(rec.Timestamp, "tool", claudeToolText(bl.Name, bl.Input))
					}
				}
			}
		})
	case "codex":
		subagent := false
		lines(bytes.NewReader(data), func(b []byte) {
			var rec struct {
				Timestamp string `json:"timestamp"`
				Type      string `json:"type"`
				Payload   struct {
					Type         string          `json:"type"`
					Source       json.RawMessage `json:"source"`
					ThreadSource string          `json:"thread_source"`
					Message      json.RawMessage `json:"message"`
					Item         json.RawMessage `json:"item"`
					Name         string          `json:"name"`
					Input        string          `json:"input"`
					Arguments    string          `json:"arguments"`
				} `json:"payload"`
			}
			if json.Unmarshal(b, &rec) != nil {
				return
			}
			p := rec.Payload
			switch {
			case rec.Type == "session_meta":
				var src string
				subagent = subagent || (p.ThreadSource != "" && p.ThreadSource != "user") || (len(p.Source) > 0 && json.Unmarshal(p.Source, &src) != nil)
			case rec.Type == "response_item" && (p.Type == "function_call" || p.Type == "custom_tool_call"):
				add(rec.Timestamp, "tool", clip(p.Name+" "+p.Input+p.Arguments))
			case rec.Type == "event_msg" && p.Type == "agent_message":
				var s string
				json.Unmarshal(p.Message, &s)
				add(rec.Timestamp, "agent", s)
			case rec.Type == "event_msg" && (p.Type == "user_message" || p.Type == "item_completed"):
				if text, ok := codexPrompt(p.Type, p.Message, p.Item); ok {
					role := "you"
					if subagent {
						role = "agent" // a subagent's "user" is the agent that started it
					}
					add(rec.Timestamp, role, text)
					return
				}
				var it struct {
					Type    string `json:"type"`
					Content []struct {
						Text string `json:"text"`
					} `json:"content"`
				}
				if json.Unmarshal(p.Item, &it) == nil && it.Type == "AgentMessage" {
					var parts []string
					for _, c := range it.Content {
						parts = append(parts, c.Text)
					}
					add(rec.Timestamp, "agent", strings.Join(parts, "\n"))
				}
			}
		})
	case "journal":
		lines(bytes.NewReader(data), func(b []byte) {
			var ev JournalEvent
			if json.Unmarshal(b, &ev) == nil && ev.Human {
				out = append(out, Message{Time: ev.Time, Role: "you", Text: "(prompt sent; recorded by a hook, which keeps no text)"})
			}
		})
	}
	return out
}

// claudeToolText describes a Claude Code tool call: the file and change for
// edits, the command for Bash, and the input otherwise.
func claudeToolText(name string, input json.RawMessage) string {
	var in struct {
		Path    string `json:"file_path"`
		Old     string `json:"old_string"`
		New     string `json:"new_string"`
		Content string `json:"content"`
		Command string `json:"command"`
	}
	json.Unmarshal(input, &in)
	switch {
	case name == "Edit":
		return clip(fmt.Sprintf("Edit %s\n%s\n%s", in.Path, prefix(in.Old, "- "), prefix(in.New, "+ ")))
	case name == "Write":
		return clip(fmt.Sprintf("Write %s\n%s", in.Path, prefix(in.Content, "+ ")))
	case in.Command != "":
		return clip(name + ": " + in.Command)
	case in.Path != "":
		return name + " " + in.Path
	}
	return clip(name + " " + string(input))
}

func prefix(s, p string) string {
	if s == "" {
		return ""
	}
	return p + strings.ReplaceAll(s, "\n", "\n"+p)
}

func clip(s string) string {
	if len(s) <= toolTextLimit {
		return s
	}
	return strings.ToValidUTF8(s[:toolTextLimit], "") + fmt.Sprintf("\n… %d more characters", len(s)-toolTextLimit)
}

func or(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}
