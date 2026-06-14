# Global Tools — Available to All Agents

These tools are installed on the Hive machine and available to every agent via Bash.

---

## SDK Built-in Tools

| Tool | Purpose |
|------|---------|
| Bash | Shell commands, system CLIs, scripts |
| Read | Read files (supports offset/limit for targeted reads) |
| Write | Create or overwrite files |
| Edit | String replacement edits on existing files |
| Glob | Fast file pattern matching |
| Grep | Regex text search across files |
| WebSearch | Search the web |
| WebFetch | Fetch content from URLs |

---

## System CLIs (via Bash)

| CLI | Purpose | Notes |
|-----|---------|-------|
| `op` | 1Password CLI | Credentials in "Son of Anton" vault. `op read "op://Son of Anton/<item>/<field>"` |
| `gh` | GitHub CLI | Repos, PRs, issues, releases. Org: (set your org). |
| `git` | Version control | Standard operations. |
| `gws` | Google Workspace CLI | Drive, Sheets, Gmail, Calendar, Docs, Slides, Tasks, People, Chat, Forms, Keep, Meet. |
| `bq` | BigQuery CLI | Query datasets, manage tables, load/export data. |
| `claude` | Claude Code CLI | AI coding assistant. Use with `-p` flag for prompts. |
| `codex` | OpenAI Codex CLI | AI coding agent. Use with `--yolo` flag in tmux. |
| `vercel` | Vercel CLI | Deploy, manage env vars, link projects, view logs. |
| `curl` | HTTP requests | API calls, health checks, data retrieval. |
| `jq` | JSON processing | Parse, filter, transform JSON data. |
| `node` | Node.js runtime | Run scripts, REPL. |
| `pnpm` / `npm` | Package managers | Install deps, run scripts. |
| `python3` | Python runtime | Scripts, data processing, utilities. |
| `pm2` | Process manager | Start/stop/restart agents, view logs. |
| `hive` | Hive CLI | Agent management, health checks, updates. |
| `tmux` | Terminal multiplexer | Background sessions for long-running tasks. |
| `docker` | Containers | Build, run, manage containers. |
| `ffmpeg` | Media processing | Video/audio conversion, extraction, manipulation. |
| `pandoc` | Document conversion | Convert between formats: Markdown, PDF, DOCX, HTML, EPUB, etc. |
| `sqlite3` | SQLite database | Local database queries and management. |
| `rg` | ripgrep | Fast regex search (prefer the Grep SDK tool instead). |

---

## Google Workspace (`gws`) Reference

```bash
# Pattern: gws <service> <resource> [sub-resource] <method> [flags]

# Drive
gws drive files list --params '{"pageSize": 10}'
gws drive files get --params '{"fileId": "abc123"}'

# Sheets
gws sheets spreadsheets get --params '{"spreadsheetId": "..."}'
gws sheets spreadsheets.values get --params '{"spreadsheetId": "...", "range": "Sheet1!A1:D10"}'

# Gmail
gws gmail users messages list --params '{"userId": "me"}'
gws gmail users messages send --params '{"userId": "me"}' --json '{"raw": "..."}'

# Calendar
gws calendar events list --params '{"calendarId": "primary"}'

# Docs
gws docs documents get --params '{"documentId": "..."}'

# Discover API schema
gws schema drive.files.list
```

**Key flags:**
- `--params <JSON>` — URL/query parameters
- `--json <JSON>` — request body (POST/PATCH/PUT)
- `--format <FMT>` — output: json (default), table, yaml, csv
- `--page-all` — auto-paginate (NDJSON, one line per page)
- `--upload <PATH>` — upload a file (multipart)
- `--output <PATH>` — save binary response to file

---

## BigQuery (`bq`) Reference

```bash
# Run a query
bq query --use_legacy_sql=false 'SELECT * FROM `project.dataset.table` LIMIT 10'

# List datasets
bq ls

# Show table schema
bq show --schema project:dataset.table

# Load data
bq load --source_format=CSV project:dataset.table ./data.csv

# Export data
bq extract project:dataset.table gs://bucket/export.csv
```

---

## 1Password (`op`) Reference

```bash
# List available credentials
op item list --vault "Son of Anton"

# Read a specific credential
op read "op://Son of Anton/<item>/<field>"

# Get full item details
op item get "<item>" --vault "Son of Anton"
```

**Rule:** No special characters in 1Password item names — breaks `op://` paths.

---

## Sending Files to Discord

To attach a file to your Discord response, include a marker in your output:

```
[ATTACH:/path/to/file.csv]
```

The bot will strip the marker and attach the actual file to your Discord message. Works with any file type Discord supports (CSV, PDF, JSON, images, etc.).

---

## Hivemind — Agent-to-Agent Communication

The **#hivemind** Discord channel is where agents talk to each other. All inter-agent messages route through this channel so the owner can monitor if they want, but it stays out of your direct conversation channels.

### How to Send a Message to Another Agent

Use the `SendMessage` MCP tool:

```
SendMessage(to: "your-analyst", message: "Research competitor TikTok Shop activity and send your findings back to me.")
```

This posts a formatted message in #hivemind:
> **[house-md → your-analyst]**
> Research competitor TikTok Shop activity and send your findings back to me.

The target agent picks it up, processes it, and responds in #hivemind:
> **[your-analyst → house-md]**
> Here are the findings...

Your bot automatically picks up responses addressed to you.

### Key Rules

- **Non-blocking**: After calling `SendMessage`, continue your current conversation immediately. Don't wait for a response.
- **Tell the owner**: Let the user know you've delegated: "I've asked your analyst agent to research that. I'll share the results when they come in."
- **Responses arrive as new messages**: When the other agent replies, it arrives in your session like any other message — tagged with `[Message from <agent> via #hivemind]`.
- **Be specific**: Include what you need and ask them to send results back to you.
- **Don't over-respond**: If another agent tells you to stop messaging, STOP. Do not acknowledge, do not confirm, do not send "no action needed." Silence IS the correct response.
- **Don't relay what's already visible**: If the owner is talking to an agent directly in that agent's channel, do not relay or summarize what they're discussing. The owner can see it.

### Available Agents

| Agent | Role | What to ask them |
|-------|------|-----------------|
| `house-md` | Chief of Staff / Generalist | Strategy, research, company context |
| `your-coder` | CTO / Coding | Code changes, deployments, technical work |
| `your-finance-agent` | CFO | Finance, QBO, Ramp, P&L, invoices |
| `your-analyst` | CIO | Data, BigQuery, Snowflake, market intelligence |
| `house-md` | Hive Architect | Agent issues, infrastructure, Hive maintenance |

---

*Updated by House MD. Changes apply to all agents on next restart.*
