# Neato Hive — v2

Personal AI agents that live in your Discord server. Each agent runs as its
own process with its own personality, memory, and channel; **House MD** is
the first agent every install starts with, and it helps you build the rest.

v2 is the cost-rearchitected generation of Hive, built for Anthropic's
June 15, 2026 per-seat metered billing:

- **Cache-correct prompts (Project Queen Bee)** — mutable agent state rides a
  per-message Session State header instead of the system prompt, so memory
  writes no longer invalidate the prompt cache. **Measured: 91.9% cache hit**
  (vs 5–20% on the v1 layout); memory-write turns hit 99%.
- **Model-tier routing** — a model catalog routes each agent to the cheapest
  viable model (DeepSeek → Gemini Flash → Kimi → Gemini Pro → Sonnet → Opus)
  across four runtimes behind one interface, with live `/swap` from Discord.
- **Spend tracking and caps** — catalog-priced per-agent costs, daily/monthly
  caps (warn at 80%, hard-stop at 100%), `/status` spend + projection.
- **Context-editing telemetry** — tool-output caps + auto-compaction, now
  persisted and surfaced (`/status` "Context edits", `cache-report`) so context
  stays lean and the cache stays provably healthy.

> **For leadership / non-technical readers:** [`docs/WHY-V2.md`](docs/WHY-V2.md)
> is a plain-language summary of the v1→v2 changes and the cost math (prompt
> caching, context editing/tracking, model right-sizing).

## Prerequisites

### Required software

- macOS or Linux machine that can run 24/7 (Windows works for development —
  build, tests, scripts — but agents run on a Unix box under PM2)
- Node.js 20+ (22 LTS recommended)
- Git
- A C toolchain (`better-sqlite3` compiles from source during `npm install`)
- Claude Code CLI and PM2 (the wizard installs PM2 if missing)
- tmux — optional, only needed for Codex coding tasks

Install everything on **macOS**:

```bash
xcode-select --install                          # C toolchain (skip if already installed)
brew install node git                           # or Node 22 LTS from nodejs.org
npm install -g pm2 @anthropic-ai/claude-code
```

On **Ubuntu/Debian**:

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3 git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pm2 @anthropic-ai/claude-code
```

### Required accounts

- **Claude Max subscription** — agents authenticate through the CLI
  (`claude setup-token`), not an API key. Pro/Free is not enough for
  continuous operation. Important: if `ANTHROPIC_API_KEY` is set in your
  shell profile it overrides the subscription and causes "credit balance
  too low" errors — leave it unset (model-lane keys go in the Hive `.env`,
  not your profile).
- A **Discord server you admin** plus a [Discord Developer
  Portal](https://discord.com/developers/applications) account. The wizard
  walks through bot creation click-by-click; the short version:
  1. New Application → name it `House MD` → **Bot** tab
  2. Reset Token → copy it (this becomes `DISCORD_BOT_TOKEN_HOUSE_MD`)
  3. Turn ON all three **Privileged Gateway Intents** (Presence, Server
     Members, Message Content — the bot is deaf without the last one) →
     Save Changes
  4. **OAuth2 → URL Generator** → scope `bot` → bot permission
     `Administrator` → open the generated URL → invite the bot to your server
  5. Create a `#house-md` channel in the server
- **Your Discord user ID** — Discord Settings → Advanced → enable Developer
  Mode, then right-click your name → Copy User ID. Agents only answer this
  ID (`DISCORD_OWNER_ID`).

### Optional

- Model-lane API keys for the cheap tiers: `OLLAMA_API_KEY` (Ollama Cloud —
  hosts DeepSeek and Kimi), `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`. Only needed
  once an agent is actually assigned a model on that lane — the wizard
  prompts for them, all skippable.
- Codex CLI, for heavy coding tasks routed through tmux

## Installation (fresh)

```bash
git clone https://github.com/notLmax/hivev2dev.git hive
cd hive
bash setup.sh
```

> The repo is **private during pre-deployment testing** — your GitHub
> account needs access, and git will prompt for auth on first clone (Git
> Credential Manager opens a browser; a fine-grained PAT also works).
> At org launch this URL changes to the published repo.

The wizard takes about 5–10 minutes:

1. Node.js check (20+)
2. PM2 check/install
3. Claude Code CLI check
4. Claude authentication (`claude setup-token` — Max account)
5. Codex CLI (optional; declining just disables Codex tasks)
6. Discord setup — create the application/bot, enable the Message Content
   intent, invite it to your server, create the `#house-md` channel
7. Working directory (added to `safety.allowed_paths` automatically)
8. Install dependencies, build, boot

When it finishes it has written `.env`, materialized House MD's behavior
files from `templates/house-md/`, started it under PM2 with boot
persistence, and House MD is waiting in the `#house-md` channel. Building
your next agents is House MD's job — it interviews you and starts from
`templates/generalist/` or `templates/coding-agent/`.

Prefer doing it by hand, or installing on a dev box? See `docs/SETUP.md`.

### Verify the install

```bash
hive doctor     # full health check (setup.sh ran `npm link`, so `hive` is on PATH)
hive status     # House MD should be online under PM2
```

Then say hello in `#house-md`. First reply can take ~15 seconds (cold
session); `/status` in the channel shows model, session, cache trend, and
spend.

## Migrating an existing v1 install

v1 installs share **no git history** with this repo — never `git pull` or
`hive update` across the boundary. Migration is an automated state
transplant (~15 minutes; the old install directory is never modified):

```bash
bash scripts/migrate-from-v1.sh --old ~/neato-hive --repo https://github.com/notLmax/hivev2dev.git
# options: --dest ~/hive2  --branch main  --backup-dir <dir>  --cutover
```

It takes a checksummed backup of your agents/.env/data/config, fresh-clones
and builds the new repo (aborts if tests are red), transplants your state,
merges your agent roster and safety paths into the new config, verifies the
transplant byte-identical against the backup manifest, and prints the PM2
cutover commands. **Day 0 nothing visible changes** — every agent keeps its
exact model, personality, and memory; the immediate win is the cache hit
rate. Rollback is starting the old directory's processes again.

Full runbook (including per-department rollout and model tier flips):
`docs/DEPLOYMENT.md`.

## Daily use

Talk to each agent in its Discord channel. Owner-only slash commands:

| Command | What it does |
|---|---|
| `/status` | model, session, cache-hit trend, spend today/month vs caps |
| `/swap model:<catalog-key>` | live model swap with a memory-bridge handoff — personality/memory/tasks port over; persists across restarts; auto-reverts if the assignment is broken |
| `/newsession` | clear the session — next message starts fresh (memory survives) |
| `/show-thinking` | toggle display of the agent's reasoning |

### Hive CLI

```
hive status                # all agents + PM2 status
hive list                  # configured agents
hive info <agent>          # detailed agent info
hive start|stop|restart <agent|all>
hive logs <agent> [lines]  # agent output (default 30 lines)

hive newsession <agent>    # clear an agent's session
hive session <agent>       # current session info

hive build                 # compile TypeScript
hive update                # pull latest, rebuild, restart all
hive doctor                # full health check
hive env                   # .env status (which keys are set, no values)
hive config                # parsed config summary
```

## Choosing models

The shipped catalog (`config/models.yaml`) defines what's assignable —
tiers, pinned model IDs, pricing. Your assignments live in
`config/models.local.yaml` (gitignored owner state, survives updates):

```yaml
agents:
  my-analyst:
    model: ollama-deepseek          # catalog key, not a raw model ID
    caps: { daily_usd: 2.00, monthly_usd: 40.00 }
```

No assignment = the agent stays on its Claude default — exact v1 behavior.
Always set `caps:` on non-Claude lanes (they bill API money, not seat
credit). A broken assignment fails loudly at startup, never mid-conversation.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Credit balance too low` | Agent is hitting the API instead of your Max subscription. Run `claude setup-token`; make sure `ANTHROPIC_API_KEY` is NOT set in your shell profile. |
| `npm install` fails on `better-sqlite3` | Missing C toolchain — `xcode-select --install` (macOS) or `apt-get install build-essential python3` (Ubuntu), then retry. |
| `npm link` / `npm install -g` fails with `EACCES` on `/opt/homebrew/...` | Shared-Homebrew Mac: the npm global root belongs to whichever account installed Homebrew, and may already hold another account's hive link. setup.sh falls back to a per-user PATH entry automatically. For global npm installs use a per-user prefix (`npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to PATH). **Never `sudo npm link`** — it would hijack the other account's `hive` command. |
| Bot is online but never replies | Message Content Intent not enabled on the bot, **or** you're messaging from an account that isn't `DISCORD_OWNER_ID` (agents only answer the owner). |
| `Channel not found` in logs | Create the `#house-md` channel (channel name must match the agent name). |
| Agent won't boot after a model assignment | Startup validation is refusing a broken catalog assignment — the log names the exact `.env` key to add. Fix it or remove the assignment from `config/models.local.yaml`. |
| Anything else | `hive doctor`, then `hive logs house-md 50`. |

## Key paths

| Path | What's there |
|------|-------------|
| `agents/` | agent behavior files + memory — **your state, untracked, survives updates** |
| `templates/` | shipped agent templates: `house-md` (factory default), `generalist`, `coding-agent` |
| `config/config.yaml` | agent roster, state-header block, safety rules |
| `config/models.yaml` | shipped model catalog (tiers, pinned IDs, pricing) |
| `config/models.local.yaml` | your per-agent model assignments + spend caps (gitignored) |
| `src/core/` | agent facade, prompt builder, Session State header, telemetry, model catalog |
| `src/runtimes/` | claude-sdk, anthropic-compat (DeepSeek/Ollama/Kimi), google-adk backends + shared tool layer |
| `src/billing/` | pricing, spend rollups, spend caps |
| `shared/`, `skills/` | universal rules and on-demand reference docs injected into agents |
| `docs/SETUP.md` | manual install / update guide |
| `docs/DEPLOYMENT.md` | org rollout runbook, migration, pre-deployment checklist |

## Development

```bash
npm install            # Node 20+, C toolchain for better-sqlite3
npm run build          # tsc — must stay green
npm test               # vitest — 83 tests
npm run cache-report   # cache KPI report from data/*.jsonl

# Live gates (cost: cents):
npm run test:cache     # 10-turn cache acceptance ≥80% (needs Claude auth)
npm run test:compat    # anthropic-compat vs Ollama Cloud (needs OLLAMA_API_KEY)

# Install/update/migrate regression harness (Linux/macOS/WSL):
bash scripts/install-test.sh all
```

Working rules and the current work-state ledger are in `CLAUDE.md`.
Development happens on `v2`; releases are orphan-squash commits (the
published tree carries no development history).

## Status

WP1–WP4 complete and validated. Before org-wide deployment, work the
pre-deployment checklist in `docs/DEPLOYMENT.md` §0.3 (macOS validation
pass, live Discord end-to-end smoke, migration dry-run against a real
legacy install).

## License

Proprietary — Neato Trading LLC. Internal use only.
