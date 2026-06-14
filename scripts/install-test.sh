#!/bin/bash
# ============================================================
#  install-test.sh — isolated install/update regression harness
#
#  Usage (from any clone of this repo, ideally a throwaway WSL
#  instance or a separate macOS user account):
#
#    bash scripts/install-test.sh            # all scenarios
#    bash scripts/install-test.sh fresh      # clone v2 → build → test → boot check
#    bash scripts/install-test.sh update     # pre-v2 install + owner state → v2, verify nothing lost
#    bash scripts/install-test.sh wizard     # drive setup.sh end-to-end with stubbed claude/pm2 (Linux/macOS only)
#    ... [--source <repo-path>] [--keep]
#
#  Everything runs in a throwaway sandbox (mktemp -d). On FAILURE the
#  sandbox is kept and its path printed so you can poke at it; on success
#  it's deleted (pass --keep to keep it anyway).
# ============================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_COMMIT="4129eb7"   # pre-v2 base (BASE-PIN)
SCENARIO="all"
KEEP=false
BRANCH="v2"

while [ $# -gt 0 ]; do
    case "$1" in
        fresh|update|wizard|migrate|all) SCENARIO="$1" ;;
        --source) shift; SOURCE_REPO="$1" ;;
        --branch) shift; BRANCH="$1" ;;
        --keep) KEEP=true ;;
        *) echo "Unknown arg: $1"; exit 2 ;;
    esac
    shift
done

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; NC='\033[0m'
PASS_COUNT=0; FAIL_COUNT=0
pass() { echo -e "${GREEN}PASS${NC} $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo -e "${RED}FAIL${NC} $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
note() { echo -e "${YELLOW}NOTE${NC} $1"; }
section() { echo ""; echo -e "${BOLD}━━━ $1 ━━━${NC}"; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/hive-install-test-XXXXXX")"
cleanup() {
    if [ "$FAIL_COUNT" -gt 0 ] || [ "$KEEP" = true ]; then
        echo ""
        note "Sandbox kept for debugging: $SANDBOX"
    else
        rm -rf "$SANDBOX"
    fi
}
trap cleanup EXIT

sha_tool() {
    if command -v sha256sum &>/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# Checksums every owner-state file (the things updates must never touch).
owner_state_manifest() {
    (
        cd "$1" || return
        find agents data config/models.local.yaml .env -type f 2>/dev/null | LC_ALL=C sort | while read -r f; do
            sha_tool "$f"
        done
    )
}

npm_quiet() { npm "$@" --no-audit --no-fund --silent; }

echo -e "${BOLD}Hive install/update test harness${NC}"
echo "source repo : $SOURCE_REPO"
echo "sandbox     : $SANDBOX"
echo "scenario    : $SCENARIO"

# ============================================================
# Scenario: fresh — clone v2, build, test, boot check
# ============================================================
run_fresh() {
    section "FRESH INSTALL (clone → build → test → boot check) [branch: $BRANCH]"
    local dir="$SANDBOX/fresh"
    git clone -q "$SOURCE_REPO" "$dir" || { fail "git clone"; return; }
    cd "$dir" && git checkout -q "$BRANCH" || { fail "checkout $BRANCH"; return; }
    pass "cloned + checked out $BRANCH"

    # The exact bug class we shipped once: a fresh clone must actually compile.
    npm_quiet install || { fail "npm install"; return; }
    npm run build --silent || { fail "npm run build (fresh clone does not compile!)"; return; }
    pass "npm install + build green"

    npm test --silent >/dev/null 2>&1 && pass "test suite green" || fail "npm test"

    # Boot check WITHOUT Discord: entry point must parse config, validate the
    # model catalog, and exit 1 with the missing-token message — proving the
    # whole startup path short of Discord works on a pristine clone.
    local out
    out=$(node dist/index.js --agent house-md 2>&1)
    if [ $? -eq 1 ] && echo "$out" | grep -q "DISCORD_BOT_TOKEN_HOUSE_MD"; then
        pass "boot check: clean exit asking for the bot token"
    else
        fail "boot check: unexpected output: $(echo "$out" | head -3)"
    fi

    # models.yaml catalog must load + validate on a pristine clone.
    out=$(node -e "
import('./dist/core/model-catalog.js').then((m) => {
  const c = m.loadModelCatalog();
  if (!c || Object.keys(c.entries).length < 5) throw new Error('catalog missing/short');
  const v = m.validateCatalog(c);
  if (v.errors.length) throw new Error('catalog errors: ' + v.errors.join('; '));
  console.log('catalog ok: ' + Object.keys(c.entries).length + ' models');
}).catch((e) => { console.error(e.message); process.exit(1); });
" 2>&1) && pass "model catalog loads + validates ($out)" || fail "model catalog: $out"
}

# ============================================================
# Scenario: update — pre-v2 install with owner state → v2
# ============================================================
run_update() {
    section "UPDATE SIMULATION ($BASE_COMMIT + owner state → v2)"
    local dir="$SANDBOX/update"
    git clone -q "$SOURCE_REPO" "$dir" || { fail "git clone"; return; }
    cd "$dir"
    if ! git rev-parse -q --verify "$BASE_COMMIT^{commit}" >/dev/null 2>&1; then
        note "base commit $BASE_COMMIT not in this repo (squashed release?) — skipping update scenario"
        return
    fi
    git checkout -q "$BASE_COMMIT" || { fail "checkout base $BASE_COMMIT"; return; }
    pass "simulated existing install at $BASE_COMMIT"
    note "base predates the compile-fix stubs — skipping build at base (known-broken upstream)"

    # Plant owner state exactly like a real install accumulates it.
    mkdir -p agents/my-agent/memory data
    printf '# Identity\n\nI am my-agent, planted by install-test.\n' > agents/my-agent/IDENTITY.md
    printf '# Memory\n\n- owner fact that must survive updates\n' > agents/my-agent/MEMORY.md
    printf -- '- planted daily memory\n' > agents/my-agent/memory/2026-06-01.md
    printf 'DISCORD_BOT_TOKEN_MY_AGENT=fake.token.for-test\nDISCORD_OWNER_ID=123456789012345678\n' > .env
    printf '{"timestamp":"2026-06-01T00:00:00Z","agent":"my-agent","inputTokens":1}\n' > data/usage.jsonl
    printf 'agents:\n  my-agent: { model: sonnet }\n' > config/models.local.yaml
    local before="$SANDBOX/owner-before.txt"
    owner_state_manifest "$dir" > "$before"
    [ -s "$before" ] && pass "owner state planted + checksummed ($(wc -l < "$before" | tr -d ' ') files)" || { fail "manifest empty"; return; }

    # Tracked-file hygiene: a real owner may have edited config.yaml (roster).
    # Our git update path requires that to be stashed/merged — surface it.
    if ! git diff --quiet 2>/dev/null; then
        note "tracked files modified at base — real installs must stash config.yaml edits before updating"
    fi

    # THE UPDATE — the documented procedure from docs/SETUP.md:
    # 1. back up agents/ (at the old base they are TRACKED; v2 untracked them,
    #    so a bare branch switch would delete those working-tree copies)
    cp -a agents "$SANDBOX/agents-backup" || { fail "agents backup"; return; }
    # 2. switch + rebuild (fetch is implicit here — same-repo clone)
    git checkout -q v2 || { fail "git checkout v2 over existing install"; return; }
    # 3. restore agent state (agents/ is gitignored on v2 — restore is clean)
    cp -a "$SANDBOX/agents-backup/." agents/ || { fail "agents restore"; return; }
    npm_quiet install || { fail "npm install after update"; return; }
    npm run build --silent || { fail "build after update"; return; }
    npm test --silent >/dev/null 2>&1 && pass "update: checkout v2 + install + build + tests green" || fail "tests after update"

    # Owner state must be byte-identical.
    local after="$SANDBOX/owner-after.txt"
    owner_state_manifest "$dir" > "$after"
    if diff -q "$before" "$after" >/dev/null; then
        pass "owner state byte-identical across the update"
    else
        fail "owner state CHANGED across update:"; diff "$before" "$after" | head -10
    fi

    # Behavior preservation: an agent with no catalog assignment must resolve
    # to its raw config model on the claude-agent-sdk runtime (passthrough),
    # and the planted models.local.yaml assignment must win for my-agent.
    local out
    out=$(node -e "
import('./dist/core/agent.js').then((m) => {
  const cfg = {
    model: 'claude-opus-4-7[1m]',
    codex: { enabled: false, command: '', args: [] },
    safety: { blocked_commands: [], allowed_paths: [], protected_paths: [] },
    agents: { passthrough: { behavior_dir: 'agents/passthrough' }, 'my-agent': { behavior_dir: 'agents/my-agent' } },
  };
  const p = m.resolveAgentConfig(cfg, 'passthrough');
  if (p.model !== 'claude-opus-4-7[1m]' || p.runtime !== 'claude-agent-sdk') throw new Error('passthrough broken: ' + p.model + '/' + p.runtime);
  const a = m.resolveAgentConfig(cfg, 'my-agent');
  if (a.model !== 'claude-sonnet-4-6') throw new Error('models.local.yaml assignment ignored: ' + a.model);
  console.log('passthrough + local assignment ok');
}).catch((e) => { console.error(e.message); process.exit(1); });
" 2>&1) && pass "resolution: $out" || fail "resolution: $out"
}

# ============================================================
# Scenario: wizard — drive setup.sh with stubbed claude/pm2
# ============================================================
run_wizard() {
    section "WIZARD DRY-RUN (setup.sh end-to-end, stubbed claude/pm2, sandboxed HOME)"
    if [[ "$OSTYPE" != "linux"* && "$OSTYPE" != "darwin"* ]]; then
        note "setup.sh targets Linux/macOS — skipping wizard scenario on $OSTYPE (run in WSL)"
        return
    fi
    local dir="$SANDBOX/wizard"
    git clone -q "$SOURCE_REPO" "$dir" || { fail "git clone"; return; }
    cd "$dir" && git checkout -q "$BRANCH" || { fail "checkout $BRANCH"; return; }

    # Stub the external commands the wizard shells out to. Real npm/node run.
    local stubs="$dir/.stubs"; mkdir -p "$stubs"
    cat > "$stubs/claude" << 'EOF'
#!/bin/sh
case "$1" in
  --version) echo "claude 2.0.0 (stub)" ;;
  auth) echo "Authenticated via Claude subscription (stub)" ;;
  *) echo "claude stub: $*" ;;
esac
exit 0
EOF
    cat > "$stubs/pm2" << 'EOF'
#!/bin/sh
echo "$*" >> "${PM2_STUB_LOG:-/dev/null}"
case "$1" in
  jlist) echo '[{"name":"house-md","pm2_env":{"status":"online"}}]' ;;
  startup) echo "sudo env PATH=\$PATH pm2 startup (stub)" ;;
  *) : ;;
esac
exit 0
EOF
    chmod +x "$stubs/claude" "$stubs/pm2"

    local fake_home="$dir/.home"; mkdir -p "$fake_home"
    local fake_token="MTQ5stubstubstubstubstub.G1vstub.stubstubstubstubstubstubstubstubstub"

    # Answers, in prompt order: claude-auth? y · codex? n · [Enter] continue ·
    # bot token · owner id · working dir [Enter=default] · 3 model keys [Enter].
    if printf 'y\nn\n\n%s\n123456789012345678\n\n\n\n\n' "$fake_token" \
        | HOME="$fake_home" PATH="$stubs:$PATH" \
          PM2_STUB_LOG="$dir/.pm2-stub.log" NPM_CONFIG_PREFIX="$dir/.npm-global" \
          bash setup.sh > "$dir/.wizard-output.log" 2>&1; then
        pass "setup.sh completed end-to-end"
    else
        fail "setup.sh exited non-zero — tail of output:"; tail -15 "$dir/.wizard-output.log"
        return
    fi

    grep -q "DISCORD_BOT_TOKEN_HOUSE_MD=$fake_token" .env && pass ".env: bot token written" || fail ".env token"
    grep -q "DISCORD_OWNER_ID=123456789012345678" .env && pass ".env: owner id written" || fail ".env owner id"
    [ -f agents/house-md/IDENTITY.md ] && pass "House MD behavior files scaffolded" || fail "scaffold missing (fresh installs boot an empty agent!)"
    grep -q "$fake_home/projects" config/config.yaml && pass "WORKING_DIR injected into safety.allowed_paths" || fail "allowed_paths not updated"
    grep -A1 "^codex:" config/config.yaml | grep -q "enabled: false" && pass "codex disabled after declining it" || fail "codex still enabled"
    grep -q "^start dist/index.js --name house-md" "$dir/.pm2-stub.log" && pass "pm2 start invoked for house-md" || fail "pm2 start not invoked"
}

# ============================================================
# Scenario: migrate — drive scripts/migrate-from-v1.sh end-to-end
# ============================================================
run_migrate() {
    section "MIGRATION (fake v1 install → migrate-from-v1.sh → verified v2)"
    local old="$SANDBOX/oldhive"
    git clone -q "$SOURCE_REPO" "$old" || { fail "git clone"; return; }
    cd "$old"
    if ! git rev-parse -q --verify "$BASE_COMMIT^{commit}" >/dev/null 2>&1; then
        note "base commit $BASE_COMMIT not in this repo (squashed release?) — skipping migrate scenario"
        return
    fi
    git checkout -q "$BASE_COMMIT" || { fail "checkout base"; return; }
    # Fake a REAL user's install: the roster lives in the gitignored overlay
    # config/agents.local.yaml (the v1-documented layout), owner identity in
    # config/users.local.yaml, and .env carries NO DISCORD_OWNER_ID — exactly
    # the shape that silently dropped agents / failed to boot before the
    # blocker-1/2 migration fixes. (The old fixture injected the roster into
    # config.yaml — the one place the script already read — so it never caught
    # this.)
    mkdir -p agents/my-agent/memory data config
    printf '# Identity\n\nI am my-agent.\n' > agents/my-agent/IDENTITY.md
    printf -- '- planted memory line\n' > agents/my-agent/memory/2026-06-01.md
    printf 'DISCORD_BOT_TOKEN_MY_AGENT=fake.token\n' > .env   # NOTE: no DISCORD_OWNER_ID
    printf '{"timestamp":"2026-06-01T00:00:00Z","agent":"my-agent","inputTokens":1}\n' > data/usage.jsonl
    cat > config/agents.local.yaml <<'YAML'
agents:
  my-agent:
    channels:
      - my-agent
    behavior_dir: agents/my-agent
YAML
    cat > config/users.local.yaml <<'YAML'
users:
  - id: owner
    name: Tester
    primary: true
    discord_ids:
      - "123456789012345678"
YAML
    pass "fake v1 install prepared (roster in agents.local.yaml, owner in users.local.yaml, no DISCORD_OWNER_ID)"

    if HOME="$SANDBOX/migrate-home" bash "$SOURCE_REPO/scripts/migrate-from-v1.sh" \
        --old "$old" --repo "$SOURCE_REPO" --branch "$BRANCH" \
        --dest "$SANDBOX/migrated" --backup-dir "$SANDBOX/v1-backup" \
        > "$SANDBOX/migrate.log" 2>&1; then
        pass "migrate-from-v1.sh completed (includes its own byte-identical verification)"
    else
        fail "migrate-from-v1.sh failed — tail:"; tail -12 "$SANDBOX/migrate.log"; return
    fi

    [ -s "$SANDBOX/v1-backup/MANIFEST.sha256" ] && pass "backup manifest written" || fail "backup manifest missing"
    [ -f "$SANDBOX/migrated/agents/my-agent/IDENTITY.md" ] && pass "agent files transplanted" || fail "agent transplant"
    grep -q "my-agent" "$SANDBOX/migrated/config/config.yaml" && pass "overlay roster (agents.local.yaml) merged into new config.yaml" || fail "BLOCKER1: my-agent from agents.local.yaml dropped"
    grep -q "house-md" "$SANDBOX/migrated/config/config.yaml" && pass "house-md kept alongside merged roster" || fail "house-md lost"
    grep -q "^DISCORD_OWNER_ID=123456789012345678" "$SANDBOX/migrated/.env" && pass "DISCORD_OWNER_ID derived from users.local.yaml" || fail "BLOCKER2: owner id not derived (agents would fail to boot)"
    [ -f "$SANDBOX/migrated/config/agents.local.yaml" ] && pass "agents.local.yaml transplanted" || fail "agents.local.yaml not transplanted"
    grep -q "pm2 start dist/index.js --name my-agent" "$SANDBOX/migrate.log" && pass "cutover commands printed (no --cutover)" || fail "cutover commands missing"
}

case "$SCENARIO" in
    fresh) run_fresh ;;
    update) run_update ;;
    wizard) run_wizard ;;
    migrate) run_migrate ;;
    all) run_fresh; run_update; run_wizard; run_migrate ;;
esac

section "RESULT"
echo -e "${GREEN}$PASS_COUNT passed${NC}, $([ "$FAIL_COUNT" -gt 0 ] && echo -e "${RED}$FAIL_COUNT failed${NC}" || echo "0 failed")"
[ "$FAIL_COUNT" -eq 0 ]
