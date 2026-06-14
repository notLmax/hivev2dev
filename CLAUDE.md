# CLAUDE.md — Hive v2 Development (the next-iteration reference base)

## What this repo is

Multi-agent personal-AI framework on the Claude Agent SDK, Discord-fronted.
This checkout is **"C"** (upstream personal-hive lineage) — the **v2 lab**
and the reference repo for the next iteration of Hive. The legacy employee
distributable is **"B"** (v1.5.24); C and B share zero commit objects, so
existing installs migrate via `scripts/migrate-from-v1.sh`, never `git pull`.

**Read first:** this file, then `docs/SETUP.md` + `docs/DEPLOYMENT.md`. Deep
background lives in `_reference/v2-context/` on dev boxes (untracked):
`04-V2-DESIGN.md` is the blueprint, `BASE-PIN.md` records the v2 base commit
(`4129eb7`) and the 2026-06-10 decisions.

**Why v2 exists:** Anthropic's June 15, 2026 billing flip meters every Agent
SDK turn against per-seat credits. Two multiplicative levers: **Project Queen
Bee** (cache-correct prompt assembly — mutable state must never live in the
system prompt) and **model-tier routing** (cheapest viable model per agent
role: DeepSeek → Gemini Flash → Kimi → Gemini Pro → Sonnet → Opus eng-only).

## Hard rules — never violate

1. **NEVER touch `agents/*/` or `_reference/`** — owner state, untracked
   (gitignored since 2026-06-10; the original 9 reference agents live in
   `_reference/agents/` as read-only worked examples). No `git stash -u`,
   no `git clean -fd`, no `git add -A`. Stage files by explicit path only.
2. **Never push `v2` or any dev-history branch to any remote** — the history
   contains pre-scrub personal data (see DEPLOYMENT.md §0.1); `origin` is the
   upstream owner's repo (fetch-only, never push). The ONLY artifact that
   leaves this machine is the orphan-squash `release` branch. Owner-authorized
   staging remote (2026-06-11): `dev` = github.com/notLmax/hivev2dev
   (private) — push `release:main` + tags there for pre-deployment testing.
   Branch: `v2`. Small, port-sized commits; messages reference the doc
   section (e.g. `queen-bee: evict mutable state (04 SS4.2)`).
3. New v2 code lives in `src/core/`, `src/runtimes/`, `src/billing/`,
   `config/models.yaml` — zero coupling to any personal agent roster
   (only House MD is global).
4. All config changes **additive with defaults preserving current behavior**.
5. **The system prompt freeze contract (Queen Bee):** nothing mutable, nothing
   per-turn in `buildSystemPrompt()`. Mutable state goes in the Session State
   header (`src/core/state-header.ts`). Tool sets must be static per agent per
   process — never per-turn (tool defs hash first in the cache prefix).
6. Queen Bee lands before/alongside model-tier work, never after.
7. If the docs are wrong about the code, say so and update them in the same
   commit (`_reference/v2-context/` is shared living context).
8. **PowerShell array footgun (this file was corrupted by it once):** a
   single replacement pair passed as `@(@("old","new"))` FLATTENS — the loop
   then sees strings and `$kv[0]`/`$kv[1]` index CHARACTERS, producing
   file-wide char swaps (s→h). Always write `@(,@("old","new"))`, or better,
   use the Edit tool for file edits. Verify docs after scripted edits — a
   broken .ts fails the build; a broken .md fails silently.

## Commands

- `npm run build` — tsc (must stay green; repo is ESM, `"type": "module"`)
- `npm test` — vitest (141 tests = 139 + 2 win32-gated skips; `tests/`, excluded from tsc)
- `npm run cache-report` — Queen Bee KPI report from `data/*.jsonl`
- `npm run test:cache` — LIVE 10-turn cache acceptance gate (needs Claude auth)
- `npm run test:compat` — LIVE anthropic-compat run vs Ollama Cloud (needs OLLAMA_API_KEY)
- `bash scripts/install-test.sh [all|fresh|update|wizard|migrate] [--branch X]`
  — install/update regression harness (run in WSL with `TMPDIR=/var/tmp`)
- `bash scripts/migrate-from-v1.sh --old <dir>` — automated v1→v2 migration
- `npm run dev` — tsx watch (needs Discord tokens; on the Windows dev box you
  usually just build + test — production runs on a Unix box via PM2)

## Architecture map

- `src/index.ts` — entry; one process per agent (`--agent <name>`); startup
  catalog validation (doctor-style)
- `src/core/agent.ts` — `runAgent()` facade: Session State header prepend →
  spend-cap check → runtime registry dispatch → catalog pricing + spend
  rollup; `resolveAgentConfig()` is the single chokepoint for model/runtime
  resolution (models.yaml + models.local.yaml overlay)
- `src/core/prompt-builder.ts` — deterministic system prompt (freeze
  contract); `buildSystemPromptDetailed()` returns text + sha256 hashes
- `src/core/state-header.ts` — per-message mutable-state header (daily
  memories + evicted MEMORY/TASKS/LESSONS/OUTPUT-LOG + codex tasks)
- `src/core/telemetry.ts` — `data/turns.jsonl` (per-turn cache KPI) +
  `data/usage.jsonl` (per-query, legacy-compatible)
- `src/core/model-catalog.ts` — catalog load/resolve/validate +
  `assignAgentModel()` (the /swap persistence)
- `src/runtimes/` — `types.ts` (AgentRuntime interface) + `registry.ts` (lazy
  dispatch); `claude-sdk-runtime.ts` (default; tool-output caps via env,
  maxBudgetUsd backstop), `google-adk-runtime.ts` (Gemini), `claude-cli`
  (stub), `anthropic-compat/` (DeepSeek/Ollama/Kimi: quirk normalizer, JSONL
  transcripts, client-side context budget, cache breakpoints)
- `src/runtimes/shared/` — runtime-agnostic tool layer for loop-owning
  runtimes: builtins with 16KB/250-path hygiene caps + all 15 hive tools
  (schema-identical to the SDK lane's MCP server) + safety gating
- `src/billing/` — catalog pricing, per-agent spend rollups, caps (warn
  80%/stop 100%)
- `src/discord/bot.ts` — Discord layer: 4 entry points calling `runAgent()`
  (message, hivemind, codex wake, cron), `/status`, `/swap` (memory-bridge),
  session persistence, codex watcher. Do NOT prepend state to prompts here.
- `src/tools/` — hive-tools MCP server, codex-tasks (tmux), messaging
  (hivemind), cron, memory; `src/safety/` — runtime-agnostic primitives
- `bin/hive` — bash ops CLI; `setup.sh` — install wizard (materializes House
  MD from `templates/house-md/`)
- `templates/` — shipped agent templates (house-md, generalist, coding-agent),
  restored from the v1 distributable, PII-scrubbed; `shared/CRITICAL-RULES.md`
  is the precedence root they reference (prompt-builder loads it first)

## Cache discipline (the core of Queen Bee — keep it true)

- Anthropic prefix hashing: `tools → system → messages`; a change at any level
  invalidates everything after. Cache read = 0.1x input price; write = 1.25x.
- System prompt = static content only (identity, tool doctrine, shared rules,
  human-timescale behavior files, skills table, safety rules).
- Mutable state (daily memory, TASKS/MEMORY/LESSONS/OUTPUT-LOG) rides the
  latest user message via the Session State header — the cached prefix
  survives every WAL write.
- Telemetry proves it: `promptHash` stable across queries = healthy;
  `cache-report` annotates hash changes expected vs accidental-churn.
- KPI gate (04 §4): ≥80% cache hit on a 10-turn session with 3 memory writes;
  byte-identical prompt determinism across writes.

## v2 work state (update this as commits land)

Branch `v2`, base `4129eb7`. **WP1–WP4 COMPLETE; Phase 0 executed locally.**
83 vitest tests green; install harness green in WSL.

1. `f4db2e8` docs: context pack tracked + BASE-PIN
2. `80d5231` fix: stubs for uncommitted claude-cli/hivemind-outbox (fresh
   checkout now compiles)
3. `027d026` queen-bee: per-turn telemetry + prompt/file hashes (04 §4.0)
4. `1c64931` queen-bee: /status cache trend + cache-report CLI (04 §4.0)
5. `ef6e2fd` queen-bee: Session State header in core (04 §4.2)
6. `5ac67c1` queen-bee: evict ALL mutable behavior files (04 §4.1–4.2)
7. `5bc5e03` queen-bee: tool-set stability + determinism invariants
8. `4ad60bc` queen-bee: vitest + determinism tests
9. `5ec745f` queen-bee: live cache acceptance — **MEASURED 91.9% ≥ 80% PASS**
   (sonnet-4-6, 2026-06-10; WAL-write queries hit 99%, prompt hash stable)
10. `9987c25` runtime: AgentRuntime interface extraction (zero behavior change)
11. `1805e17` runtime: config/models.yaml catalog + resolution (additive)
12. `b5d8c42` billing: catalog pricing, spend caps (warn 80%/stop 100%,
    facade-enforced), /status spend; canonical inputTokens=uncached (ADK fixed)
13. `eaf420f` wp3-preflight: **Ollama Cloud VERIFIED Anthropic-compatible**
    (compat-smoke; deepseek-v4-flash/-pro + kimi-k2.6 hosted) — catalog repinned
14. `86e58c7` runtime: models.local.yaml overlay + rollout playbook (doc 06)
15. `b02c476` queen-bee: SDK-lane tool-output caps (BASH_MAX_OUTPUT_LENGTH
    16384, MAX_MCP_OUTPUT_TOKENS 10000) + per-query maxBudgetUsd backstop.
    NOTE: Agent SDK 0.2.0 has NO tool-result-clearing API — long-session
    pruning = SDK auto-compaction (Claude lane) / client budget (compat lane)
16. `a62591c` chore: **personal state pruned** — agents/ untracked, moved
    intact to `_reference/agents/`; config genericized to House-MD-only.
    NOTE: personal files remain in git HISTORY pre-`a62591c` — the published
    artifact is the orphan-squash `release` branch, never this history
17. `f5dffc6` runtime: **WP3 anthropic-compat VERIFIED LIVE** vs Ollama Cloud
    deepseek-v4-flash (Write-tool round-trip + session resume,
    `npm run test:compat`); auth sends x-api-key AND Bearer (Ollama needs Bearer)
18. `87f4b1b` feat: **/swap** — live model swap with memory-bridge handoff
    (WP4); assignment persists to models.local.yaml, auto-reverts on failure
19. `bef4fb9`+`a680...` chore: repo-wide personal-reference scrub (audit by
    grep over tracked files), personal dev docs → `_reference/`, SETUP guide.
    ⚠ this commit also introduced the s→h corruption of THIS file (see Hard
    rule 8) — fixed in the rewrite commit that re-cut the release
20. `7fc2e3e` setup.sh audited for v2: scaffolds `agents/house-md/` on fresh
    installs (CRITICAL — agent state is untracked, clones ship no behavior
    files), WORKING_DIR injected into safety.allowed_paths, optional
    model-lane keys, codex-decline disables the MCP, node replaces python3
21. `326a642` test: install/update regression harness
    (`scripts/install-test.sh`) — caught the tracked-agents-deleted-on-
    branch-switch hazard; SETUP.md backup/restore step is load-bearing
22. `bd0e13b`/`bc263ee` docs+feat: DEPLOYMENT.md runbook; Phase 0 executed
    locally (orphan-squash `release` branch + tag `v2.0.0`, tree clean and
    byte-identical to v2; push gated on org repo URL);
    `scripts/migrate-from-v1.sh` (checksummed backup → transplant → roster
    merge → byte-identical verification → cutover). WSL-validated: full
    harness 17/17, migrate 7/7, fresh-from-release 5/5

23. README rewritten for v2-current; **pre-deployment test checklist** added
    to DEPLOYMENT.md §0.3 (done vs blocking vs pilot-phase) — the gate for
    any user migration.

24. deployment-readiness audit pass: README rewritten user-facing
    (prereqs/install/migrate/daily-use, modeled on the v1 distributable's
    README per owner request); .env.example duplicate token line fixed +
    optional model-lane keys documented; version 1.0.4 → 2.0.0 in
    package.json/bin/hive (was numerically BELOW v1's 1.5.24); stray root
    `context/` deleted (verified byte-identical dupe of
    `_reference/v2-context/` — contained personal refs and was untracked
    but NOT gitignored, one `git add .` from leaking); `release` re-cut +
    `v2.0.0` re-tagged on the new tree. KNOWN-OPEN: npm audit — moderate
    advisories in agent-sdk's nested @anthropic-ai/sdk (bump alongside the
    live smoke, not blind), high-sev chain under @google/adk (fix = breaking
    0.3.0; lane unvalidated this release anyway).

25. feat: `templates/` restored from the v1 distributable per owner request —
    house-md, generalist, coding-agent, "as they were" minus personal state.
    v1 had tracked the owner's LIVE House MD state as the template; its
    LESSONS/MEMORY/TASKS (owner quotes, agent names, incident logs, a
    person-named GitHub org path) reset to skeletons here, all other files
    verbatim. `shared/CRITICAL-RULES.md` restored from v1 (prompt-builder's
    SHARED_FILE_PRECEDENCE + every template's precedence header expect it;
    the v2 tree had silently dropped it). setup.sh now materializes
    agents/house-md from templates/house-md (v1 parity) instead of the
    inline heredoc. KNOWN DRIFT kept verbatim per "as they were": template
    text references v1 features absent from this base — `hive task launch`,
    runner-events.log, hive-architecture/codex-protocol skills,
    agent-watcher.mjs, shared/exchange/ + CREDENTIALS.md. Revisit with the
    pilot (or port those pieces).

26. staging: private repo `notLmax/hivev2dev` (owner request 2026-06-11),
    local remote name `dev`; pushed `release:main` + tag `v2.0.0`. Purpose:
    run §0.3 yourself (macOS pass, fresh-clone wizard, migration dry-run
    with `--repo`) against a real remote before anything touches the live
    repos. Update cadence: commit on `v2` → re-cut `release` + retag →
    `git push dev release:main --force` (+ `--force` on the tag if moved) —
    each re-cut is a new orphan root, so staging history never accumulates.

27. docs: README install audit (owner request) — clone/migrate URLs now
    point at staging `notLmax/hivev2dev` (the README had pointed at the V1
    repo, so following it cloned v1.5.24; swap to the org URL at launch);
    per-OS prereq install commands; Discord bot SOP matched to the wizard's
    ACTUAL steps (all 3 privileged intents + Administrator — README had
    invented a minimal-permission variant); verify-the-install +
    troubleshooting sections. SETUP.md: fresh install no longer says
    `git checkout v2` (branch doesn't exist on the published artifact),
    documents `npm link`. setup.sh: example Discord ID replaced — the old
    one looked like a real snowflake.

28. feat+docs: `hive update` framework_paths expanded — was missing
    `config/models.yaml` (catalog repins NEVER propagated to users),
    shared/, skills/, scripts/, docs/, tests/, package-lock; dirty-check
    matched; config/config.yaml + models.local.yaml stay owner-state
    (explicit file path for models.yaml, never config/ wholesale).
    docs/MAC-TEST-PLAN.md added — §0.3 runbook on a throwaway macOS
    account: fresh v2 install, realistic v1 fixture (Claude-only),
    migration, and hive-update-within-v2 vs a force-pushed staging re-cut
    (update = fetch + selective checkout, no merge → survives orphan
    roots). KEY FACT verified in v1.5.24 source: v1's `hive update` is a
    website-tarball overlay (never git) — v1→v2 cannot ride `hive update`;
    `migrate-from-v1.sh` is the only path. Update DEPLOYMENT comms
    accordingly.

29. fix: setup.sh npm-link EACCES on shared-Homebrew Macs — FOUND BY the
    first live Phase B run (2026-06-11): npm's global root is owned by the
    first brew account and already held the main account's v1 `neato-hive`
    link; `npm link` died and `set -e` aborted the wizard BEFORE pm2 start
    (install half-done, House MD never launched). Now ownership-checked and
    never fatal: falls back to a per-user PATH entry for `bin/hive`
    (realpath-based HIVE_ROOT works unlinked); never overwrites another
    account's link, never sudo (would hijack their `hive`). README
    troubleshooting row + MAC-TEST-PLAN shared-Homebrew note.

30. fix: `hive doctor` false warnings — FOUND BY the live Mac run: the
    per-agent required-files check still listed CRITICAL-RULES.md (a
    shared/ file since the prompt-builder took it over — never per-agent)
    and TOOLS.md (doesn't exist in this architecture; the shared file is
    GLOBAL-TOOLS.md), so every healthy agent warned twice forever. Now:
    new 8b shared-files check (shared/CRITICAL-RULES.md +
    shared/GLOBAL-TOOLS.md, hive-level, "run: hive update" hint); per-agent
    list corrected to IDENTITY/AGENTS/SOUL/USER — what every template
    actually ships.

31. queen-bee: context-editing telemetry PERSISTED (04 §4.8) — both lanes
    detected edits but threw the detail away (console-only; in-memory
    /status counter died on restart). Now: RunAgentResult.contextEdits
    {compactions, compactionPreTokens, prunedToolResults, droppedMessages}
    → usage.jsonl (additive optional fields); SDK lane counts
    compact_boundary + captures pre_tokens; compat lane fixed to flag
    phase-1-only trims (pruned tool results WITHOUT dropped messages
    previously didn't set `compacted`) and records final-extent counts
    (enforceBudget is pure over the full transcript — overwrite, never
    sum); cache-report §4 "Context editing" per-agent totals + expected-
    bust note; /status label "Compactions" → "Context edits". No prompt-
    assembly changes (freeze contract untouched). 83 tests green.

32. catalog: `kimi` entry added (kimi-k2.6 via Ollama Cloud — quirks profile
    already existed in the normalizer; the tier was runtime-ready but
    unassignable since WP3, caught by the owner's SDK-coverage question).
    DEPLOYMENT §2.0/§2.0b: catalog propagation via hive update
    (inert-until-assigned) + per-swap verification checklist. Google lane
    needs NO code for assignability (catalog entries + wizard key prompt +
    .env.example present) — gated on the org GEMINI_API_KEY and a live
    pilot turn, plus the deferred ADK-onto-shared-tool-registry port.

33. catalog: **fleet default tier** (`defaults.model`, 04 §3 extension) —
    owner directive: every agent auto-switches to deepseek-v4-pro on update
    without per-user action. Resolution precedence gains step 3: explicit
    assignment > model-as-key > defaults.model > passthrough. The default
    is SOFT (the one resolution path that never throws): missing api key /
    explicit config.yaml runtime / unimplemented runtime → passthrough +
    console warning, so update-before-key and key-before-update are both
    safe orderings and a fleet flip can never brick an install. Opt-outs:
    models.local.yaml assignment (wins), `defaults: { model: none }`
    locally. validateCatalog flags an inert default. models.yaml ships
    `defaults: { model: deepseek-pro }`. DEPLOYMENT §2.0a flip runbook
    (what survives: all behavior files + shared rules + memory via state
    header; what doesn't: in-flight transcript — fresh session, graceful).
    +6 vitest tests (89 total). ⚠ The first commit of this entry (e075423)
    also mojibake-corrupted this file via Get-Content/Set-Content — hard
    rule 8 extended: NEVER script-edit .md files, Edit tool only; fixed in
    the follow-up commit.

34. audit+remediation: two adversarial multi-agent investigations (update
    channel + full v2-vs-v1.5.24 parity, ~58 agents total) against the REAL
    deployed repo `anthonyconnelly/neato-hive` v1.5.24 cloned to a dev temp.
    KEY FACTS: (a) `hive update` on v1.5.24 is a Vercel-tarball overlay
    (neato-hive-site.vercel.app/releases/current.json) — NOT git; pushing v2
    to any GitHub repo is inert to the fleet; the release SERVER is the
    lever. (b) v1 reads only the global `model:` key — per-agent models
    (House on Opus while the fleet flips) REQUIRE v2. (c) v2 default
    passthrough = v1-identical (confirmed). Audit verdict: fresh install =
    v1 + improvements, but migrating a real fleet was NOT safe. Fixed all 5
    BLOCKERS + 2 must-fixes (full detail: notes/AUDIT-FINDINGS.md, dev-box):
    - safety hooks UN-hardened on BOTH lanes (../ traversal escaped
      allowed_paths; 2>/dev/null hard-blocked) → ported v1 hardened
      safety-hooks.ts + command-filter.ts into src/safety + shared lane;
      +45-case test (commit 68da178).
    - protected_paths dropped ~/.ssh + ~/.codex → restored (68da178).
    - cron lost per-agent ownership (every agent fired every job) → restored
      agent field + HIVE_AGENT_NAME gating, both tool lanes scope to owner
      (a21e77a).
    - migration dropped the roster (real fleets keep it in gitignored
      config/agents.local.yaml; verify manifest false-green) + dropped owner
      (users.local.yaml → v2 hard-exits on missing DISCORD_OWNER_ID) →
      migrate-from-v1.sh now merges agents.local.yaml (both shapes,
      overlay-wins), derives DISCORD_OWNER_ID from the primary user, die()s
      on any orphaned agent dir, manifest covers config overlays;
      install-test.sh fixture rewritten to the real overlay layout (a0a19dc).
    - templates commanded nonexistent tools (EscalateToOwner/sendToOwnChannel
      /hive task launch/codex-protocol) → rewritten to LaunchCodexTask/
      ListCodexTasks/SendMessage({to,message}); hivemind large-message
      offload to shared/exchange/ restored (2053ec4).
    DECISIONS (owner): single-owner firm (no multi-user build; migration just
    derives the one owner); ONE Claude plan + one shared key per user, agents
    share it → claude_config_dir multi-seat isolation NOT needed (dropped from
    scope). 141 vitest (139 + 2 win32-gated skips). Build green. STILL
    PENDING before fleet: live Discord smoke, Mac §0.3 pass, real-fixture
    migration dry-run, deepseek-direct live turn, Ollama key rotation.

35. validation+docs: ran the install-test harness on the dev box (Git Bash) —
    fresh 5/5, update 5/5, migrate 9/9 (wizard self-skips on msys, run in
    WSL/Mac). The migrate run CAUGHT a real bug in the blocker-1/2 fix: owner-id
    derivation appends DISCORD_OWNER_ID to .env, but the byte-identical verify
    ran AFTER and flagged .env changed → abort. Fixed (89f11e5): verify the
    pure transplant first, then append the derived owner. Added
    docs/WHY-V2.md — CEO/leadership plain-language v1↔v2 comparison centered on
    prompt-cache reads/writes + context editing/tracking (the focus area) +
    the cost math (6× measured, ~50× combined estimate). README points to it;
    context-editing telemetry called out in the README feature list.

Next:

- Work the DEPLOYMENT.md §0.3 blocking checklist: macOS pass, live Discord
  end-to-end smoke (incl. /swap + caps), migration dry-run on a REAL legacy
  install copy, Ollama pricing pin, key rotation.
- Push `release` → org repo `main` + tag (awaiting owner go + URL); provision
  org model-lane keys (1Password).
- Phase-2 validation (04 §7): assign a real role agent to `ollama-deepseek`
  in `config/models.local.yaml`, run a week, judge via cache-report.
- Then: pilot migrations → department waves → tier flips (DEPLOYMENT.md);
  later: hivemind flag, runner heartbeat, ADK lane onto the shared tool
  registry, dashboard/GUI work (playbook §4).

## Gotchas

- **Release re-cut discipline (learned 2026-06-12):** NEVER chain `git
  commit` and the orphan re-cut in one shell command. A failed commit (e.g.
  PowerShell mangling a here-string with embedded double quotes — pass
  commit messages via `git commit -F <file>` instead) leaves staged changes
  that the orphan re-cut then commits onto `release` ONLY, and the
  `checkout v2` afterwards silently reverts the working tree — release and
  v2 diverge. Sequence: commit → VERIFY (`git log -1`, tests) → re-cut →
  verify identity with `git diff --exit-code release v2` (without
  `--exit-code` the diff always exits 0 and proves nothing) → push.
- Fresh checkouts of upstream `main` do NOT compile (dangling imports — fixed
  on this branch by stubs; see BASE-PIN.md).
- `usage.jsonl` legacy field names are load-bearing (the legacy dashboard
  reads them) — extend, never rename.
- `bot.ts` `ATTACHMENTS_DIR` is `/tmp/...` (Unix-only, pre-existing). New code
  must use `path.join` / `os.tmpdir()` — it runs on Windows dev + Unix prod.
- PowerShell 5.1 is the dev shell; production is bash/tmux/PM2. In WSL, run
  the harness with `TMPDIR=/var/tmp` — systemd wipes `/tmp` at distro boot,
  so kept-on-failure sandboxes in `/tmp` evaporate between invocations.
- `better-sqlite3` compiles from source: installs need build-essential +
  python3 (Xcode CLT on macOS).
- Per-agent `model:`/`runtime:` live in `config/config.yaml`; per-agent
  catalog assignments + caps live in `config/models.local.yaml` (owner state).
