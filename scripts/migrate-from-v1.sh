#!/bin/bash
# ============================================================
#  migrate-from-v1.sh — automated v1 → v2 migration (DEPLOYMENT.md Phase 1)
#
#    bash scripts/migrate-from-v1.sh --old ~/neato-hive [--repo <url|path>]
#         [--dest ~/hive2] [--branch main] [--backup-dir <dir>] [--cutover]
#
#  What it does, in order:
#    1. BACKUP the old install's owner state (agents/, .env(.local), data/,
#       and the config OVERLAYS agents.local.yaml/users.local.yaml/
#       models.local.yaml) into a timestamped dir with a sha256 manifest
#    2. clone the v2 repo, build, run its test suite
#    3. TRANSPLANT all of the above into the new install
#    4. MERGE the old roster (config.yaml AND the gitignored
#       agents.local.yaml overlay — where real fleets keep it) + safety paths
#       + global model into the new config.yaml, and derive DISCORD_OWNER_ID
#       from users.local.yaml when .env doesn't carry it
#    5. VERIFY the transplanted owner state byte-matches the backup manifest
#       AND that every agent directory became a roster entry (no silent drop)
#    6. print the PM2 cutover commands (or run them with --cutover)
#
#  The old install directory is NEVER modified — rollback is just starting
#  PM2 from the old path again.
# ============================================================

set -euo pipefail

OLD=""; REPO=""; DEST="$HOME/hive2"; BRANCH="main"; BACKUP_DIR=""; CUTOVER=false
while [ $# -gt 0 ]; do
    case "$1" in
        --old) shift; OLD="$1" ;;
        --repo) shift; REPO="$1" ;;
        --dest) shift; DEST="$1" ;;
        --branch) shift; BRANCH="$1" ;;
        --backup-dir) shift; BACKUP_DIR="$1" ;;
        --cutover) CUTOVER=true ;;
        *) echo "Unknown arg: $1"; exit 2 ;;
    esac
    shift
done

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
die()  { echo -e "${RED}✗${NC} $1"; exit 1; }

[ -n "$OLD" ] || die "--old <existing-install-dir> is required"
OLD="$(cd "$OLD" 2>/dev/null && pwd)" || die "old install not found"
[ -f "$OLD/config/config.yaml" ] || die "$OLD doesn't look like a hive install (no config/config.yaml)"
[ -d "$OLD/agents" ] || die "$OLD has no agents/ directory"
[ ! -e "$DEST" ] || die "destination $DEST already exists — choose another --dest or remove it"
if [ -z "$REPO" ]; then
    REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    warn "no --repo given — using this script's own repo: $REPO"
fi

sha_tool() { if command -v sha256sum &>/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# Checksums owner state that is transplanted VERBATIM: agents/, data/, .env(.local),
# and the gitignored config overlays. config.yaml is intentionally EXCLUDED — it is
# merged (not copied), so it legitimately differs between v1 and v2.
manifest() { # $1 = root dir
    ( cd "$1" && { find agents data .env .env.local \
        config/agents.local.yaml config/users.local.yaml config/models.local.yaml \
        -type f 2>/dev/null || true; } | LC_ALL=C sort | while read -r f; do sha_tool "$f"; done )
}

echo -e "${BOLD}Hive v1 → v2 migration${NC}"
echo "old install : $OLD"
echo "new repo    : $REPO (branch: $BRANCH)"
echo "destination : $DEST"

# ── 1. Backup (automatic, checksummed) ─────────────────────────
BACKUP_DIR="${BACKUP_DIR:-$HOME/hive-v1-backup-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$BACKUP_DIR/config"
cp -a "$OLD/agents" "$BACKUP_DIR/agents"
[ -f "$OLD/.env" ]       && cp "$OLD/.env"       "$BACKUP_DIR/.env"
[ -f "$OLD/.env.local" ] && cp "$OLD/.env.local" "$BACKUP_DIR/.env.local"
[ -d "$OLD/data" ]       && cp -a "$OLD/data"    "$BACKUP_DIR/data"
cp "$OLD/config/config.yaml" "$BACKUP_DIR/config.yaml.v1"   # merge source (not verified)
# The gitignored owner-state overlays — where real fleets actually keep their
# roster + owner identity. Mirrored under config/ so the manifest matches DEST.
for f in agents.local.yaml users.local.yaml models.local.yaml; do
    [ -f "$OLD/config/$f" ] && cp "$OLD/config/$f" "$BACKUP_DIR/config/$f"
done
manifest "$BACKUP_DIR" > "$BACKUP_DIR/MANIFEST.sha256"
[ -s "$BACKUP_DIR/MANIFEST.sha256" ] || die "backup manifest is empty — aborting before touching anything else"
ok "backup: $BACKUP_DIR ($(wc -l < "$BACKUP_DIR/MANIFEST.sha256" | tr -d ' ') files checksummed)"
[ -f "$BACKUP_DIR/config/agents.local.yaml" ] && ok "  found config/agents.local.yaml (overlay roster) — will be merged"
[ -f "$BACKUP_DIR/config/users.local.yaml" ]  && ok "  found config/users.local.yaml (owner identity) — will derive DISCORD_OWNER_ID"

# ── 2. Clone + build + test ────────────────────────────────────
git clone -q "$REPO" "$DEST"
( cd "$DEST" && git checkout -q "$BRANCH" )
ok "cloned $BRANCH into $DEST"
( cd "$DEST" && npm install --no-audit --no-fund --silent ) || die "npm install failed (need Node 20+, build-essential/python3 for better-sqlite3)"
( cd "$DEST" && npm run build --silent ) || die "build failed"
( cd "$DEST" && npm test --silent >/dev/null 2>&1 ) && ok "new install builds, tests green" || die "test suite failed in the new install"

# ── 3. Transplant owner state ──────────────────────────────────
cp -a "$BACKUP_DIR/agents/." "$DEST/agents/"
[ -f "$BACKUP_DIR/.env" ]       && cp "$BACKUP_DIR/.env"       "$DEST/.env"
[ -f "$BACKUP_DIR/.env.local" ] && cp "$BACKUP_DIR/.env.local" "$DEST/.env.local"
[ -d "$BACKUP_DIR/data" ]       && mkdir -p "$DEST/data" && cp -a "$BACKUP_DIR/data/." "$DEST/data/"
for f in agents.local.yaml users.local.yaml models.local.yaml; do
    [ -f "$BACKUP_DIR/config/$f" ] && cp "$BACKUP_DIR/config/$f" "$DEST/config/$f"
done
ok "transplanted agents/, .env(.local), data/, config overlays"

# ── 4. Merge roster (config.yaml + agents.local.yaml overlay) ──
# v2 reads the roster from config.yaml ONLY (no agents.local.yaml reader), so
# the overlay MUST be folded into config.yaml or those agents vanish. Overlay
# wins over committed config.yaml (v1 overlay semantics). Then a hard guard:
# every agent directory must become a roster key, or we refuse to continue.
merge_rc=0
( cd "$DEST" && node -e "
const yaml = require('js-yaml');
const fs = require('fs');
const load = (p) => { try { return yaml.load(fs.readFileSync(p, 'utf-8')) || {}; } catch { return {}; } };

const oldCfg = load(process.argv[1]);                 // config.yaml.v1 (committed roster)
const cfg = load('config/config.yaml');               // v2 House-MD-only base

// agents.local.yaml overlay — accept Shape A ({agents:{...}}) and Shape B (bare map).
let overlayRoster = {};
if (fs.existsSync('config/agents.local.yaml')) {
  const ov = load('config/agents.local.yaml');
  if (ov && typeof ov === 'object') {
    if (ov.agents && typeof ov.agents === 'object') overlayRoster = ov.agents;
    else if (!('agents' in ov)) overlayRoster = ov;   // Shape B
  }
}

// Precedence: v2 base (house-md) < committed config.yaml agents < local overlay.
cfg.agents = Object.assign({}, cfg.agents, oldCfg.agents || {}, overlayRoster);
if (oldCfg.model) cfg.model = oldCfg.model;
cfg.safety = cfg.safety || {};
for (const k of ['allowed_paths', 'protected_paths', 'blocked_commands']) {
  cfg.safety[k] = [...new Set([...(cfg.safety[k] || []), ...((oldCfg.safety || {})[k] || [])])];
}
if (oldCfg.codex) cfg.codex = oldCfg.codex;
fs.writeFileSync('config/config.yaml', yaml.dump(cfg, { lineWidth: 100 }));

// HARD GUARD: every agent directory that ships behavior files MUST be wired to
// a roster entry, or its state is silently orphaned (the exact v1.5.24 bug).
const rosterDirs = new Set(
  Object.values(cfg.agents || {})
    .map((a) => (a && a.behavior_dir ? String(a.behavior_dir).replace(/^agents\//, '').replace(/\/+$/, '') : null))
    .filter(Boolean)
);
const rosterKeys = new Set(Object.keys(cfg.agents || {}));
const orphans = [];
for (const d of fs.readdirSync('agents', { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const looksLikeAgent = fs.existsSync('agents/' + d.name + '/IDENTITY.md');
  if (!looksLikeAgent) continue;
  if (!rosterDirs.has(d.name) && !rosterKeys.has(d.name)) orphans.push(d.name);
}
if (orphans.length) {
  console.error('ORPHANED_AGENTS:' + orphans.join(','));
  process.exit(3);
}
console.log(Object.keys(cfg.agents).join(', '));
" "$BACKUP_DIR/config.yaml.v1" > /tmp/.hive-roster.$$ 2>/tmp/.hive-rerr.$$ ) || merge_rc=$?
if [ "${merge_rc:-0}" -ne 0 ]; then
    if grep -q "ORPHANED_AGENTS:" /tmp/.hive-rerr.$$ 2>/dev/null; then
        orphans="$(sed -n 's/.*ORPHANED_AGENTS://p' /tmp/.hive-rerr.$$)"
        rm -f /tmp/.hive-roster.$$ /tmp/.hive-rerr.$$
        die "these agent directories have state but NO roster entry (would be silently dropped): ${orphans}. Their roster lives in the old config/agents.local.yaml — ensure it was copied, or add them to config/config.yaml manually. Backup intact at $BACKUP_DIR"
    fi
    cat /tmp/.hive-rerr.$$ 2>/dev/null || true
    rm -f /tmp/.hive-roster.$$ /tmp/.hive-rerr.$$
    die "roster merge failed"
fi
ok "config.yaml roster merged: $(cat /tmp/.hive-roster.$$)"
rm -f /tmp/.hive-roster.$$ /tmp/.hive-rerr.$$
warn "config.yaml was rewritten by the merge — inline docs/comments live in git; review it once"

# ── 5. Verify transplant against the backup manifest ──────────
# Runs BEFORE the owner-id derivation below so .env is still byte-identical to
# the backup here — the derivation deliberately appends to it afterwards.
AFTER="$(mktemp)"; manifest "$DEST" > "$AFTER"
MISSING=0
while read -r sum file; do
    grep -qF "$sum" "$AFTER" || { echo "  missing/changed: $file"; MISSING=$((MISSING + 1)); }
done < "$BACKUP_DIR/MANIFEST.sha256"
rm -f "$AFTER"
[ "$MISSING" -eq 0 ] && ok "owner state verified byte-identical against the backup manifest" \
                     || die "$MISSING file(s) differ from the backup — DO NOT cut over; backup is intact at $BACKUP_DIR"

# ── 5b. Owner identity: v2 requires DISCORD_OWNER_ID at boot ────
# AFTER verify (this appends to .env — a deliberate post-transplant change, so
# it must not run before the byte-identical check). Modern v1 keeps the owner
# in config/users.local.yaml (DISCORD_OWNER_ID is deprecated there); v2 needs
# DISCORD_OWNER_ID in .env or it hard-exits. Derive it from the primary user.
if grep -q '^DISCORD_OWNER_ID=.' "$DEST/.env" 2>/dev/null; then
    ok "DISCORD_OWNER_ID present in .env"
elif [ -f "$DEST/config/users.local.yaml" ]; then
    ids="$(cd "$DEST" && node -e "
      const yaml = require('js-yaml'); const fs = require('fs');
      const u = yaml.load(fs.readFileSync('config/users.local.yaml','utf-8')) || {};
      const users = Array.isArray(u.users) ? u.users : [];
      const primary = users.find((x) => x && x.primary === true) || users[0];
      const ids = (primary && Array.isArray(primary.discord_ids) ? primary.discord_ids : []).map(String);
      console.log(ids.join(' '));
    " 2>/dev/null || true)"
    owner="$(echo "$ids" | awk '{print $1}')"
    rest="$(echo "$ids" | cut -s -d' ' -f2- | tr ' ' ',')"
    if [ -n "$owner" ]; then
        printf '\n# Derived from config/users.local.yaml during v1→v2 migration\nDISCORD_OWNER_ID=%s\n' "$owner" >> "$DEST/.env"
        [ -n "$rest" ] && printf 'DISCORD_AUTHORIZED_USERS=%s\n' "$rest" >> "$DEST/.env"
        ok "derived DISCORD_OWNER_ID=$owner from users.local.yaml${rest:+ (+authorized: $rest)}"
    else
        die "users.local.yaml has no primary user discord_ids — set DISCORD_OWNER_ID in $DEST/.env manually before starting (v2 won't boot without it)"
    fi
else
    die "no DISCORD_OWNER_ID in .env and no config/users.local.yaml — set DISCORD_OWNER_ID in $DEST/.env before starting (v2 won't boot without it)"
fi

# ── 6. Cutover ─────────────────────────────────────────────────
AGENTS=$(cd "$DEST" && node -e "
const yaml = require('js-yaml'); const fs = require('fs');
const cfg = yaml.load(fs.readFileSync('config/config.yaml', 'utf-8'));
console.log(Object.keys(cfg.agents || {}).join(' '));
")
if [ "$CUTOVER" = true ] && command -v pm2 &>/dev/null; then
    ( cd "$OLD" && pm2 stop all ) || true
    pm2 delete all 2>/dev/null || true
    for a in $AGENTS; do ( cd "$DEST" && pm2 start dist/index.js --name "$a" -- --agent "$a" ); done
    pm2 save
    ok "cutover complete — agents started from $DEST"
else
    echo ""
    echo -e "${BOLD}Cutover (run when ready):${NC}"
    echo "  cd $OLD && pm2 stop all && pm2 delete all"
    for a in $AGENTS; do echo "  cd $DEST && pm2 start dist/index.js --name $a -- --agent $a"; done
    echo "  pm2 save"
fi
echo ""
echo -e "${BOLD}Rollback:${NC} pm2 delete all, then start the old processes from $OLD (untouched)."
echo -e "${BOLD}Verify:${NC} message each agent in Discord (personality+memory intact), check /status."
