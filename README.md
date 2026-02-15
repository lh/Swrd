# Swrd

Context distillation for Claude Code CLI.

Indexes every tool call in your session into a SQLite FTS5 database, annotates entries with an LLM, and injects relevant historical context back into future prompts — so Claude remembers what happened earlier in long sessions.

Inspired by the context distillation system in [Damocles](https://github.com/AizenvoltPrime/damocles), a VS Code extension for Claude. Swrd extracts that idea and makes it work purely from the command line via Claude Code's hook system.

## How it works

```
You type a prompt
       │
       ├─► RETRIEVE: FTS5 search finds relevant past activity
       │   └─► Injected into your prompt as additionalContext
       │
       ▼
Claude responds, using tools...
       │
       ▼
Turn ends
       │
       ├─► INDEX: Tool calls grouped into logical entries in SQLite
       └─► ANNOTATE: LLM enriches entries with descriptions, tags,
           semantic groups, and cross-prompt links
```

Four hooks wire into Claude Code:

| Hook | What it does |
|------|-------------|
| `SessionStart` | Creates a SQLite DB for the session |
| `UserPromptSubmit` | Queries FTS5 and injects relevant context |
| `PostToolUse` (async) | Buffers each tool call to a JSONL file |
| `Stop` | Flushes buffer to DB, annotates entries |

## Install

```bash
cd /path/to/swrd
npm install
npm run build
```

Add hooks to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "node /path/to/swrd/dist/cli.js session-start", "timeout": 5 }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "node /path/to/swrd/dist/cli.js on-prompt", "timeout": 5 }]
    }],
    "PostToolUse": [{
      "hooks": [{ "type": "command", "command": "node /path/to/swrd/dist/cli.js on-tool", "timeout": 5, "async": true }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "node /path/to/swrd/dist/cli.js on-stop", "timeout": 10 }]
    }]
  }
}
```

## Configuration

Create `~/.distill/config.json`:

```json
{
  "annotator": "self",
  "tokenBudget": 4000
}
```

### Annotation modes

**Self-annotation** (default) — rule-based, instant, free. Derives descriptions and tags from tool call data.

**LLM annotation** — richer descriptions, semantic groups, and cross-prompt links. Supports any OpenAI-compatible or Anthropic-compatible API:

```json
{
  "annotator": "haiku",
  "provider": "openai",
  "apiBaseUrl": "https://api.deepseek.com",
  "apiKey": "sk-...",
  "model": "deepseek-chat",
  "tokenBudget": 4000
}
```

Works with DeepSeek, OpenAI, Together, OpenRouter, or any Anthropic-compatible endpoint. Set `"provider": "anthropic"` for Anthropic/OpenRouter APIs.

Self-annotation always runs first for immediate retrieval. When LLM annotation is enabled, it upgrades entries in the background.

## CLI

```
swrd sessions              # list all sessions
swrd status <session_id>   # show entry counts
swrd inspect <session_id>  # show all entries with annotations
swrd search <session_id> <query>  # test retrieval
```

## Storage

- Session databases: `~/.distill/sessions/<session_id>.db`
- Tool call buffers: `~/.distill/buffers/<session_id>.jsonl`
- Config: `~/.distill/config.json`

## Tech

- **SQLite FTS5** with porter stemming for full-text search
- **better-sqlite3** (native) for fast cold start in hook commands
- **BM25 ranking** with semantic group expansion
- Standalone FTS5 table with `fts_map` for safe updates (avoids content-synced FTS5 corruption)
