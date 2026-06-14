# Hive — Clean Install & Update Guide (v2 base)

## Fresh install from this repo

1. **Prereqs (Unix box):** Node 20+, npm, PM2 (`npm i -g pm2`), tmux, git,
   and a C toolchain — `build-essential` + `python3` on Debian/Ubuntu, Xcode
   CLT on macOS — because `better-sqlite3` compiles from source (found the
   hard way by the install harness on a minimal Ubuntu image); `claude` CLI
   logged in (`claude setup-token`) for Claude-lane agents.
2. **Clone + build**
   ```bash
   git clone <repo-url> hive && cd hive    # published artifact: default branch (main)
   # dev checkout only: git checkout v2
   npm install && npm run build && npm test
   npm link                                # puts `hive` (bin/hive) on PATH
   ```
3. **Environment** — copy `.env.example` → `.env` and fill:
   `DISCORD_BOT_TOKEN_HOUSE_MD` (Discord Developer Portal: New Application →
   Bot → enable Message Content intent → copy token; invite the bot to your
   guild), `DISCORD_OWNER_ID` (your Discord user ID), `WORKING_DIR`.
   Optional model lanes: `OLLAMA_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY`
   — only needed once a catalog model requiring them is assigned.
4. **Config** — `config/config.yaml`: set `safety.allowed_paths` to YOUR
   working directories; the roster ships House-MD-only. Materialize House
   MD's behavior files from the shipped template (`setup.sh` does this
   automatically):
   ```bash
   mkdir -p agents/house-md/memory && cp -R templates/house-md/. agents/house-md/
   ```
   New role agents start from `templates/generalist/` or
   `templates/coding-agent/` (House MD's interview flow does the copying
   and customization).
5. **Model tiers (optional)** — assign per-agent models in
   `config/models.local.yaml` (owner state, survives updates):
   `agents: { house-md: { model: sonnet, caps: { daily_usd: 10 } } }`
6. **Run** — `bash setup.sh` (guided) or directly:
   `pm2 start dist/index.js --name house-md -- --agent house-md`
   then `hive doctor` / `hive status`. Verify caching with
   `npm run test:cache` and watch `/status` + `npm run cache-report`.

## Updating an EXISTING hive install to this code (`hive update` path)

`hive update` = `git pull` + rebuild + restart, against the install's own
origin. To test against THIS repo before it's published anywhere:

1. **Back up `agents/` — load-bearing, not optional.** On pre-v2 lineages
   agent files are git-TRACKED; v2 untracked them, so a bare branch switch
   DELETES the working-tree copies (caught by the install-test harness).
   Also back up `.env`, `config/models.local.yaml`, `data/` (untracked —
   they survive anyway, but belt-and-braces):
   ```bash
   cp -a agents /tmp/agents-backup
   ```
2. Point a remote at this repo, fetch, switch, **restore agents/**, rebuild:
   ```bash
   git remote add v2base <path-or-url-to-this-repo>
   git fetch v2base && git checkout -b v2 v2base/v2
   cp -a /tmp/agents-backup/. agents/    # agents/ is gitignored on v2
   npm install && npm run build && npm test && hive restart all
   ```
   If you edited tracked files (e.g. the config.yaml roster), stash first and
   re-apply manually — the v2 config ships House-MD-only by design.
3. **What changes on day 0: nothing visible.** Agents keep their exact
   models (no catalog assignment = passthrough); the only effect is one
   cache bust on the first query, then 90%+ hit rates. New surfaces:
   `/status` cache+spend lines, `/swap <catalog-key>`, `cache-report`.
4. **Rollback** = `git checkout <previous-branch>` + restore agents/ the
   same way + rebuild + restart.

## Regression harness (`scripts/install-test.sh`)

One command verifies all of the above in a throwaway sandbox — run it in a
disposable WSL instance or any Linux/macOS shell:

```bash
bash scripts/install-test.sh            # all scenarios
bash scripts/install-test.sh fresh      # clone v2 → build → tests → boot + catalog checks
bash scripts/install-test.sh update     # pre-v2 install + planted owner state → v2; asserts
                                        # owner files byte-identical + model passthrough
bash scripts/install-test.sh wizard     # drives setup.sh end-to-end with stubbed
                                        # claude/pm2 and a sandboxed HOME (Linux/macOS only)
# flags: --source <repo-path>  --keep (keep sandbox; kept automatically on failure)
```

On failure the sandbox path is printed and preserved for debugging.

Caveats: installs descending from the employee distributable ("B") share no
git history with this repo — for those, port the v2 modules as PRs (see
`_reference/v2-context/06-ROLLOUT-PLAYBOOK.md` on a dev box) rather than
switching branches. The `v2` branch's git HISTORY still contains pre-scrub
personal files; run a history filter before any public hosting.
