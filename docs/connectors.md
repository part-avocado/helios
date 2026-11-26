# Connectors

Chat apps have no hooks, but they can add a connector: a remote MCP server. Your site is one, at `/mcp`.

Add it to a chat app, and that app's chats add to your hours. It works with Claude on the web (claude.ai), the Claude desktop and mobile apps, ChatGPT, or any app that takes a remote MCP server with OAuth.

## Add it

1. In Claude, open Settings, then Connectors, and choose Add custom connector. Other apps have a similar place.
2. Give it your site's address followed by `/mcp`, such as `https://helios.example/mcp`. Other apps ask for the same address.
3. The app sends you to your site, which shows what the connector will do. Choose Allow.

Your site makes the app a sync key named after it, such as "Claude connector". To disconnect the app, revoke that key under Settings, Setup.

## What it records

The connector gives the model two tools:

| Tool | What it does |
| --- | --- |
| `helios_log` | The model calls it with `start` when it begins a reply and `end` when it finishes. Each call is one record, a prompt or a turn end, like the ones a harness's hooks send. |
| `helios_stats` | Reads your hours, per day and per project, to answer questions such as "how much did I work this week?" |

A record carries:

- the conversation, as a digest of the name the model gives it;
- the word count of your message;
- the repository, if you name one.

It never carries your message or the reply.

## How chat time counts

- **Time.** The site stamps each record with the time it arrives, so a chat's time is witnessed like any other. It is credited by the same rules as any other tool's.
- **Tool name.** A chat counts under the app's own name, such as `claude-ai` or `chatgpt`, so reviewers can tell chat time from time in coding tools.
- **Project.** Chats name no project unless the model passes a repository, such as `github.com/owner/name`. Without one, they show as the app's chats.

> [!NOTE]
> The model decides when to call the tools. A chat in which it doesn't call them adds nothing. If yours skips them, ask it to log the conversation with helios.
