# Hive v2 — Deployment Runbook (every existing user)

How to take this repo from "reference base" to "what everyone runs," migrate
existing installs without losing any agent state, and move agents onto
cheaper models — per-agent, reversibly, including live `/swap`.

Two deployment channels exist; this runbook covers **Channel 1 (this repo
becomes the new upstream)** in full, because that is the current direction.

> **Channel 2 (alternative, per the original 04 §7 plan):** port the v2
> modules into the legacy employee repo as 5 bounded PRs and ship through its
> existing tarball updater. Choose this only if keeping the legacy dashboard/
> runner matters more than shipping everything now. See
> `_reference/v2-context/06-ROLLOUT-PLAYBOOK.md` on a dev box.

---

## Phase 0 — One-time admin prep (before any user touches anything)

### 0.1 Scrub history and publish (BLOCKING — do not skip)

The `v2` branch's **git history** still contains pre-scrub personal data
(agent memory journals, names, machine paths). Never host this repo as-is.
The clean, simple fix is an orphan-squash release branch — one commit, zero
history.

> **STATUS 2026-06-10: done locally.** Branch `release` (single commit,
> tree byte-identical to `v2`, grep-verified clean of personal references)
> and tag `v2.0.0` exist in this repo. Remaining step — push once the org
> repo exists:

```bash
# new private repo in the org, then:
git remote add origin <org-repo-url>
git push -u origin release:main
git push origin v2.0.0
```

To cut future releases: re-run the squash (`git tag -d ... ; git branch -D
release; git checkout --orphan release; git commit ...`) or, once published,
develop on the new repo directly with normal PR flow.

Day-to-day development continues on this repo's `v2`; each release is a
squash onto the published `main` (or adopt normal PR flow on the new repo
from here on). The dev repo with full history stays private to you.

### 0.2 Provision model-lane accounts and keys

| Lane | Account | Key | Notes |
|---|---|---|---|
| Ollama Cloud | org account | `OLLAMA_API_KEY` | hosts deepseek-v4-flash/-pro, kimi-k2.6 — verified Anthropic-compatible |
| DeepSeek direct | org account | `DEEPSEEK_API_KEY` | cost-optimal endgame (first-party implicit caching) |
| Gemini | org account | `GEMINI_API_KEY` | google-adk lane |

Put keys in 1Password; users paste them into their install's `.env` (the
wizard prompts for them; all optional). **Recommendation: per-user keys**
where the provider allows it — per-agent attribution already comes free from
`usage.jsonl`/`data/spend/`, but per-user keys add provider-side isolation
and revocability. Pin Ollama Cloud's per-token pricing into
`config/models.yaml` once the org plan is known, so compat-lane `/status`
spend numbers are real.

### 0.3 Pre-deployment test checklist

**Done (2026-06-10, evidence in the CLAUDE.md ledger):**

- [x] Unit suites — 83 vitest tests (determinism, catalog, billing, compat
      normalizer/budget/breakpoints, shared tools, safety gating)
- [x] LIVE cache acceptance — 91.9% ≥ 80% gate, WAL-write turns 99%
      (`npm run test:cache`, sonnet-4-6)
- [x] LIVE anthropic-compat — tool round-trip + session resume on
      deepseek-v4-flash via Ollama Cloud (`npm run test:compat`)
- [x] Install harness in WSL Ubuntu 24.04 — fresh 5/5, update 6/6 (owner
      state byte-identical), wizard 7/7, migrate 7/7
- [x] Release artifact — fresh install from the squashed `release` branch
      5/5; tree grep-verified clean of personal references

**Remaining — blocking before any user migrates** (step-by-step runbook for
all of these on one throwaway Mac account: `docs/MAC-TEST-PLAN.md`)**:**

- [ ] **macOS validation pass** (production boxes are Macs): clone + build
      (Xcode CLT for better-sqlite3), `bash scripts/install-test.sh all`,
      `setup.sh` once for real, `bin/hive` commands (BSD sed/grep), launchd
      `pm2 startup`.
- [ ] **Live Discord end-to-end smoke** (test guild + throwaway bot token —
      nothing on this branch has run through the real Discord layer yet;
      the live gates call `runAgent()` directly): message → reply with
      personality + Session State; `/status` (cache trend + spend lines);
      `/newsession`; **`/swap`** to `ollama-deepseek` → converse → handoff
      note present in daily memory → `/swap` back to a Claude model.
- [ ] **Spend caps end-to-end**: tiny cap on the test agent
      (`caps: { daily_usd: 0.05 }`) → drive past 80% (one warn, deduped) →
      past 100% (hard stop message, no dispatch) → next local day resets.
- [ ] **Migration dry-run against a REAL legacy install copy** (not the
      simulated fixture): the legacy config.yaml has keys the fixture
      doesn't (users.local.yaml reference, dashboard settings) — verify the
      roster merge against a genuine copy, on the Mac.
- [ ] **Ollama Cloud pricing pinned** in `config/models.yaml` — until then,
      compat-lane `/status` spend reads $0.00 and caps don't bite on that
      lane.
- [ ] **Rotate the Ollama API key** (it transited chat during development)
      and confirm `.env` is absent from the release tree (gitignored).

**Remaining — strongly recommended before the org-wide waves (pilot-phase):**

- [ ] **One-week pilot soak** on 1–2 real installs: cache-report trend over
      real traffic, spend rollover across midnight/month boundaries in
      production timezone, compaction behavior on long sessions.
- [ ] **Cron + codex-wake paths live** (agent-type cron fires through the
      facade with the state header; `LaunchCodexTask` on a box with
      tmux + codex CLI).
- [ ] **google-adk lane live turn** if any pilot agent uses Gemini — the
      eviction + usage-semantics changes touched that lane and it has no
      live validation on this branch (needs GEMINI_API_KEY). Otherwise mark
      the lane "not validated this release" in comms.
- [ ] **Hivemind/multi-agent smoke** if any user runs >1 agent: SendMessage
      between two live agents, loop guards intact.

---

## Phase 1 — Migrating each existing install

Existing installs descend from the legacy employee repo and **share no git
history with the new upstream** — migration is a fresh clone plus a state
transplant, not a `git pull`. Budget ~15 minutes per user. Everything is
reversible because the old install directory is never modified.

### 1.0 The automated path (preferred): `scripts/migrate-from-v1.sh`

Steps 1.1–1.4 below are fully automated — run from any checkout/clone of the
new repo:

```bash
bash scripts/migrate-from-v1.sh --old ~/neato-hive --repo <org-repo-url>
# options: --dest ~/hive2  --branch main  --backup-dir <dir>  --cutover
```

It performs, in order: **checksummed backup** of agents/.env/data/config
into a timestamped directory (sha256 manifest; aborts if the manifest is
empty), fresh clone + build + test (aborts on red), state transplant,
**roster + safety-path + global-model merge** from the old config.yaml into
the new one, **byte-identical verification** of the transplanted owner state
against the backup manifest (refuses cutover on any mismatch), and finally
prints the PM2 cutover commands (or runs them with `--cutover`). The old
install directory is never modified. Note: the config merge rewrites
config.yaml without its inline comments — review it once after migration.

The whole flow is regression-tested by `scripts/install-test.sh migrate`
(fake v1 install → migrate → assertions on backup manifest, transplant,
roster merge, cutover output).

The manual equivalent, for reference or partial runs:

### 1.1 Stop and back up (old install directory)

```bash
cd ~/neato-hive          # or wherever the v1 install lives
pm2 stop all
cp -a agents  ~/hive-v1-backup-agents      # behavior files + memory — the crown jewels
cp    .env    ~/hive-v1-backup.env
cp -a data    ~/hive-v1-backup-data        # usage history, cron jobs, codex tasks
cp config/config.yaml ~/hive-v1-roster.yaml  # roster reference for step 1.3
```

### 1.2 Fresh clone + build

```bash
git clone <org-repo-url> ~/hive2 && cd ~/hive2
npm install && npm run build && npm test     # must be green before continuing
```

### 1.3 Transplant state

```bash
cp -a ~/hive-v1-backup-agents/. agents/      # agents/ is untracked owner state in v2
cp ~/hive-v1-backup.env .env                 # token var names are unchanged (DISCORD_BOT_TOKEN_<AGENT>)
cp -a ~/hive-v1-backup-data/. data/          # usage.jsonl history, cron-jobs.json, codex-tasks.json all forward-compatible
```

Recreate the roster in `config/config.yaml` from `~/hive-v1-roster.yaml` —
v2 ships House-MD-only, so add each of the user's agents back:

```yaml
agents:
  house-md:
    channels: [house-md]
    behavior_dir: agents/house-md
  my-analyst:                      # one block per existing agent
    channels: [my-analyst]
    behavior_dir: agents/my-analyst
```

Also set `safety.allowed_paths` to the user's real working directories
(v2 ships a `/tmp`-only placeholder) and add any model-lane keys to `.env`.

### 1.4 Cut over

```bash
pm2 delete all                                # old process definitions point at the old dist/
pm2 start dist/index.js --name house-md -- --agent house-md   # repeat per agent
pm2 save
hive doctor && hive status                    # via npm link, or bash bin/hive
```

### 1.5 Verify (per user, ~2 minutes)

- Message each agent in Discord — it responds **with its old personality and
  memory** (behavior files + Session State header carry everything; the SDK
  conversation itself doesn't survive the move — by design, the first
  message reloads full state).
- `/status` shows the new lines: cache trend, spend.
- Second message onward: cache trend climbs toward 90%+ (first query after
  migration is the one expected cold bust).

**Rollback:** the old directory is untouched — `pm2 delete all`, start the
old processes from the old path, done.

**What users notice on day 0: nothing else.** No model changes happen at
migration time — every agent stays on its existing Claude model via
passthrough until a tier is assigned (Phase 2). The win they get immediately
is Queen Bee caching (measured 91.9% hit vs 5–20%). One nuance since the
fleet default landed (§2.0a): this holds because the transplanted v1 `.env`
has no `DEEPSEEK_API_KEY` — the shipped `defaults.model` stays inert. If you
distribute the key BEFORE a user migrates, their agents come up on
deepseek-v4-pro at cutover. Sequence keys after migration unless that's
intended.

---

## Phase 2 — Porting agents to different models

Model assignment lives in **`config/models.local.yaml`** — owner state,
gitignored, survives every update. The shipped catalog
(`config/models.yaml`) defines what's assignable; admins repin model IDs and
prices org-wide through releases.

### 2.0 How catalog changes reach users (`hive update`)

`config/models.yaml` is in `hive update`'s framework paths (since
2026-06-12), so new tiers, ID repins, and price changes propagate on the
user's next `hive update` — which also rebuilds and restarts all agents, so
the new catalog is live immediately after. Two properties make this safe:

- **An updated catalog changes nothing by itself.** Assignments live in
  `models.local.yaml` (never touched by update); an agent with no assignment
  stays on its Claude default. Shipping a new tier is inert until someone
  assigns it.
- **A broken assignment fails loudly at restart, not mid-conversation** —
  startup validation names the exact `.env` line to add. The matching
  failure mode for `/swap` is the auto-revert.

Rollout order for a new tier therefore is: ship the catalog entry → users
`hive update` (inert) → distribute the API key → assign per agent (config
route or `/swap`), pilot-first.

### 2.0a Fleet default flip (`defaults.model` — the no-per-user-action path)

The shipped catalog carries `defaults: { model: deepseek-pro }`. Resolution
order per agent: explicit assignment (models.local.yaml > shipped agents
block) > config.yaml model-as-catalog-key > **fleet default** > passthrough.
The default is SOFT by design — it applies only when `DEEPSEEK_API_KEY` is
present in that install's `.env`; otherwise the agent stays on passthrough
with a console warning (`hive doctor`/startup logs name the missing key).
It can never turn a working agent into a boot failure.

So the org-wide flip is exactly two distributed steps, in either order:

1. Users run `hive update` (catalog with the default arrives — inert
   without the key; agents restart on their current models).
2. Users add `DEEPSEEK_API_KEY=...` to `.env` and `hive restart all` —
   every unassigned agent comes up on deepseek-v4-pro, capped by
   `defaults.caps`, priced (spend metering live from turn one).

What survives the flip with NO action: personality (IDENTITY/SOUL/AGENTS/
USER in the system prompt), shared CRITICAL-RULES/GLOBAL-TOOLS doctrine,
MEMORY/TASKS/LESSONS/OUTPUT-LOG and daily memory (Session State header),
skills. What does NOT: the in-flight conversation transcript — the runtime
switch starts a fresh session (resume across runtimes is impossible by
construction; the bot degrades gracefully: "session resume failed —
starting fresh"). Substance lives in daily memory via WAL discipline.
Announce the flip window so users finish sensitive in-flight threads first.

Opt-outs (document in the announcement): pin an agent in models.local.yaml
(e.g. `house-md: { model: sonnet }` — RECOMMENDED for House MD and any eng
agent per the tier policy in 2.3), or cancel install-wide with
`defaults: { model: none }` in models.local.yaml.

### 2.0b Per-swap verification (run after EVERY agent's first swap)

1. `/status` — shows the new catalog key/model and runtime.
2. Converse — old personality + memory intact (behavior files + Session
   State header carry everything; the handoff note covers in-flight work).
3. Check today's daily memory file for the handoff note written pre-swap.
4. `hive logs <agent> 30` — no auth/quirk errors from the new lane.
5. Next day: `/status` spend line is non-zero on priced lanes (if it reads
   $0.00 on a non-Claude lane, pricing isn't pinned — caps are NOT
   protecting that agent).
6. `/swap` back once to prove the return path, then forward again.

### 2.1 Assign a tier (config route)

```yaml
# config/models.local.yaml
agents:
  my-analyst:
    model: ollama-deepseek          # catalog key, NOT a raw model ID
    caps: { daily_usd: 2.00, monthly_usd: 40.00 }
  my-coder:
    model: sonnet
    caps: { daily_usd: 10.00 }
```

Then `hive restart my-analyst`. Startup validation refuses to boot an agent
whose assignment is broken (missing API key, unknown key, runtime conflict)
and names the exact `.env` line to add — failures are loud and pre-flight,
never mid-conversation.

### 2.2 Or swap live from Discord (on-the-fly selection)

```
/swap model:ollama-deepseek
```

The `/swap` command does the whole port in one step, per agent, owner-only:

1. the **current** model writes a handoff note (open threads, decisions)
   into today's daily memory;
2. the assignment is written to `models.local.yaml` (so it persists);
3. config re-resolves — a bad assignment throws and **auto-reverts**;
4. a fresh session starts on the new model, and the Session State header
   hands it the agent's full identity, memory, tasks, and the handoff note.

Swapping back is the same command. What ports: personality, MEMORY/TASKS/
LESSONS, daily memory, skills — everything durable. What doesn't: the
verbatim in-flight transcript (its substance rides the handoff note).
Per-TURN auto-routing is deliberately not a feature — it busts caches and
forks sessions for marginal savings.

### 2.3 Recommended tier policy (from the planning directives)

- Every **role/workflow agent** starts on `ollama-deepseek` (or
  `deepseek-flash` direct once the org key exists). Escalate only on
  measured workflow failure — never vibes — and record the reason.
- **Generalist/orchestration** agents: `sonnet`.
- **`opus`**: engineering only (`restricted_to: [eng]` in the catalog), with
  heavy coding routed through Codex (`coding_backend: codex`).
- Always set `caps:` on non-Claude lanes — they bill API money, not seat
  credit. Warn fires at 80% (once/day), hard-stop at 100%, plus a per-query
  USD backstop on the Claude lane.

### 2.4 Watch the result

- `/status` — per-agent spend today/month vs caps, projected month, cache trend.
- `npm run cache-report` — fleet hit rates, prompt-churn attribution,
  per-file churn.
- `data/usage.jsonl` has both `costUsdComputed` (catalog-priced) and
  `costUsdReported` — neither is authoritative vs the provider console;
  reconcile monthly.

---

## Rollout sequencing (org level)

1. **Pilot**: migrate 1–2 power users; run a week; check cache-report and
   spend deltas against their pre-migration usage.jsonl history.
2. **Waves**: migrate per department. Day 0 = caching savings only.
3. **Tier flips**: per department, assign cheap tiers via
   `models.local.yaml` (or teach users `/swap`); watch a week per wave.
4. Keep the legacy install dirs around for a month as rollback, then clean.
