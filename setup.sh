#!/bin/bash

# ============================================================
#  Neato Hive — Setup Wizard
#  Sets up your personal AI agent runtime.
# ============================================================

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_header() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}${BOLD}         🐝  Neato Hive Setup  🐝         ${NC}${CYAN}║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""
    echo "This wizard will set up your personal AI agent runtime."
    echo "It takes about 5 minutes. Let's go."
    echo ""
}

print_step() {
    echo ""
    echo -e "${BOLD}━━━ Step $1: $2 ━━━${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

prompt_continue() {
    echo ""
    read -p "Press Enter to continue..."
}

# Helper: ensure a command is in PATH, fix if needed
ensure_npm_global_path() {
    if command -v "$1" &>/dev/null; then
        return 0
    fi

    # Command not found — try to fix PATH
    local npm_prefix
    npm_prefix=$(npm config get prefix 2>/dev/null)
    if [ -n "$npm_prefix" ] && [ -d "$npm_prefix/bin" ]; then
        export PATH="$npm_prefix/bin:$PATH"
        if command -v "$1" &>/dev/null; then
            # Persist the fix
            local shell_rc="$HOME/.zshrc"
            [[ "$SHELL" == *bash* ]] && shell_rc="$HOME/.bashrc"
            if ! grep -q "$npm_prefix/bin" "$shell_rc" 2>/dev/null; then
                echo "export PATH=\"$npm_prefix/bin:\$PATH\"" >> "$shell_rc"
                print_warning "Added $npm_prefix/bin to PATH in $(basename "$shell_rc")"
            fi
            return 0
        fi
    fi

    return 1
}

# ============================================================
# Pre-flight
# ============================================================

print_header

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
    echo "Detected: macOS"
elif [[ "$OSTYPE" == "linux"* ]]; then
    OS="linux"
    echo "Detected: Linux"
else
    print_error "Unsupported OS: $OSTYPE"
    echo "Hive supports macOS and Linux."
    exit 1
fi

# ============================================================
# Step 1: Node.js
# ============================================================

print_step "1/8" "Checking Node.js"

if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 20 ]; then
        print_success "Node.js $NODE_VERSION installed"
    else
        print_error "Node.js $NODE_VERSION is too old (need 20+)"
        echo "Install the latest version from https://nodejs.org"
        exit 1
    fi
else
    print_error "Node.js is not installed"
    echo ""
    if [[ "$OS" == "macos" ]]; then
        echo "Install with Homebrew:"
        echo "  brew install node"
        echo ""
        echo "Or download from https://nodejs.org"
    else
        echo "Install with your package manager:"
        echo "  sudo apt install nodejs npm    # Ubuntu/Debian"
        echo "  sudo dnf install nodejs npm    # Fedora"
        echo ""
        echo "Or download from https://nodejs.org"
    fi
    exit 1
fi

# ============================================================
# Step 2: PM2
# ============================================================

print_step "2/8" "Checking PM2"

if command -v pm2 &> /dev/null; then
    print_success "PM2 installed"
else
    echo "Installing PM2 (process manager for your agents)..."
    npm install -g pm2

    # Verify it's accessible
    if ! ensure_npm_global_path pm2; then
        print_error "PM2 installed but not found in PATH."
        echo "Try opening a new terminal and running setup.sh again."
        exit 1
    fi
    print_success "PM2 installed"
fi

# ============================================================
# Step 3: Claude Code CLI
# ============================================================

print_step "3/8" "Checking Claude Code CLI"

if command -v claude &> /dev/null; then
    CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
    print_success "Claude Code CLI installed ($CLAUDE_VERSION)"
else
    echo "Installing Claude Code CLI..."
    curl -fsSL https://claude.ai/install.sh | bash
    # Source shell profile to pick up new PATH
    [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true
    [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
    if ! command -v claude &>/dev/null; then
        print_warning "Claude CLI installed but not in PATH yet."
        echo "You may need to open a new terminal after setup."
    else
        print_success "Claude Code CLI installed"
    fi
fi

# ============================================================
# Step 4: Claude Authentication
# ============================================================

print_step "4/8" "Claude Authentication"

# --- Check for ANTHROPIC_API_KEY conflicts ---
API_KEY_CONFLICT=false
API_KEY_FILES=()

# Check environment
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    API_KEY_CONFLICT=true
fi

# Check shell profiles
for rc_file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.bash_profile"; do
    if [ -f "$rc_file" ] && grep -q "ANTHROPIC_API_KEY" "$rc_file" 2>/dev/null; then
        API_KEY_CONFLICT=true
        API_KEY_FILES+=("$rc_file")
    fi
done

if [ "$API_KEY_CONFLICT" = true ]; then
    echo -e "${YELLOW}⚠  Found ANTHROPIC_API_KEY in your environment.${NC}"
    echo ""
    echo "Hive's Claude lane uses your Claude MAX/Pro subscription (via"
    echo "'claude setup-token'), NOT an API key. Having an API key in your"
    echo "shell profile overrides the subscription and causes 'credit balance"
    echo "too low' errors. (Model-lane keys — DEEPSEEK/OLLAMA/GEMINI — belong"
    echo "in this repo's .env file, never in your shell profile.)"
    echo ""

    if [ ${#API_KEY_FILES[@]} -gt 0 ]; then
        echo "Found in:"
        for f in "${API_KEY_FILES[@]}"; do
            echo "  $f"
        done
        echo ""
    fi

    read -p "Remove ANTHROPIC_API_KEY from your environment? (Y/n): " REMOVE_KEY
    if [[ "$REMOVE_KEY" != "n" && "$REMOVE_KEY" != "N" ]]; then
        # Remove from shell profiles
        for rc_file in "${API_KEY_FILES[@]}"; do
            if [ -f "$rc_file" ]; then
                # Create backup
                cp "$rc_file" "${rc_file}.bak"
                # Remove the line(s) containing ANTHROPIC_API_KEY
                grep -v "ANTHROPIC_API_KEY" "$rc_file" > "${rc_file}.tmp" && mv "${rc_file}.tmp" "$rc_file"
                print_success "Removed from $rc_file (backup: ${rc_file}.bak)"
            fi
        done
        # Unset from current session
        unset ANTHROPIC_API_KEY
        print_success "ANTHROPIC_API_KEY cleared"
    else
        print_warning "Leaving ANTHROPIC_API_KEY in place. You may hit billing errors."
    fi
    echo ""
fi

# --- Authenticate ---
echo "You need a Claude MAX or Pro subscription."
echo -e "${BOLD}Important:${NC} Do NOT use an API key. Use your subscription login."
echo ""
read -p "Have you already run 'claude setup-token'? (y/n): " CLAUDE_AUTH

if [[ "$CLAUDE_AUTH" != "y" && "$CLAUDE_AUTH" != "Y" ]]; then
    echo ""
    echo "Running claude setup-token..."
    echo "A browser window will open. Sign in with your Claude account."
    echo ""
    claude setup-token
fi

# --- Verify auth type ---
echo ""
echo "Verifying authentication..."
AUTH_OUTPUT=$(claude auth status 2>&1 || true)

if echo "$AUTH_OUTPUT" | grep -qi "api.key\|api_key\|apikey"; then
    echo ""
    print_error "Claude is authenticated with an API key, not a subscription."
    echo ""
    echo "Hive requires a Claude MAX or Pro subscription."
    echo "Run 'claude setup-token' to authenticate with your subscription."
    echo ""
    echo "If you previously set an ANTHROPIC_API_KEY, make sure it's been"
    echo "removed from your shell profile (~/.zshrc, ~/.bashrc, etc.)"
    echo "and open a new terminal before trying again."
    exit 1
fi

print_success "Claude authenticated"

# ============================================================
# Step 5: Codex CLI (Optional)
# ============================================================

print_step "5/8" "Codex CLI (Optional)"

echo "Codex is OpenAI's coding CLI, used by agents with"
echo "'coding_backend: codex' for heavy coding tasks (keeps token-heavy"
echo "codegen off your Claude credit). Optional — skip it unless you have"
echo "an OpenAI subscription and plan to run coding agents."
echo ""
read -p "Install Codex CLI? (y/n): " INSTALL_CODEX

if [[ "$INSTALL_CODEX" == "y" || "$INSTALL_CODEX" == "Y" ]]; then
    if command -v codex &> /dev/null; then
        print_success "Codex CLI already installed"
    else
        echo "Installing Codex CLI..."
        npm install -g @openai/codex
        print_success "Codex CLI installed"
        echo ""
        echo "You'll need to authenticate Codex separately."
        echo "Run 'codex' in your terminal after setup to log in."
    fi
    # Codex tasks run in tmux sessions (src/tools/codex-tasks.ts)
    if ! command -v tmux &> /dev/null; then
        print_warning "tmux is not installed — Codex task launching needs it."
        if [[ "$OS" == "macos" ]]; then
            echo "  Install with: brew install tmux"
        else
            echo "  Install with: sudo apt install tmux  (or your package manager)"
        fi
    fi
else
    print_success "Skipping Codex (agents use the Claude lane for coding)"
    # config.yaml ships with codex.enabled: true — disable so the codex MCP
    # server isn't spawned pointlessly (a missing CLI would error each query).
    if command -v node &> /dev/null && [ -f config/config.yaml ]; then
        node -e "
const fs = require('fs');
let t = fs.readFileSync('config/config.yaml', 'utf-8');
t = t.replace(/^codex:(\r?\n)  enabled: true/m, 'codex:\$1  enabled: false');
fs.writeFileSync('config/config.yaml', t);
" 2>/dev/null && print_success "Disabled codex MCP in config.yaml (re-enable later if needed)" || true
    fi
fi

# ============================================================
# Step 6: Discord Setup
# ============================================================

print_step "6/8" "Discord Setup"

echo "Each agent needs a Discord bot. Let's create one for House MD,"
echo "your first agent. House builds and maintains all your other agents."
echo ""
echo -e "${BOLD}Do this now:${NC}"
echo ""
echo "  1. Go to https://discord.com/developers/applications"
echo "  2. Click 'New Application'"
echo "  3. Name it: House MD"
echo "  4. Click 'Create'"
echo "  5. Click 'Bot' in the left sidebar"
echo "  6. Click 'Reset Token' → copy the token"
echo "  7. Turn on ALL THREE toggles under 'Privileged Gateway Intents':"
echo "     - Presence Intent → ON"
echo "     - Server Members Intent → ON"
echo "     - Message Content Intent → ON"
echo "  8. Click 'Save Changes'"
echo "  9. Click 'OAuth2' → 'URL Generator'"
echo "  10. Check 'bot' under Scopes"
echo "  11. Check 'Administrator' under Bot Permissions"
echo "  12. Copy the URL at the bottom, open it in your browser"
echo "  13. Select your Discord server → Authorize"
echo "  14. Create a channel called #house-md in your server"
echo ""

prompt_continue

# --- Bot token with validation ---
echo ""
read -p "Paste your House MD bot token here: " BOT_TOKEN

while true; do
    if [ -z "$BOT_TOKEN" ]; then
        print_error "Bot token can't be empty"
        read -p "Paste your House MD bot token here: " BOT_TOKEN
        continue
    fi

    # Discord bot tokens are base64-encoded and typically 59-76 chars with dots
    if [[ ! "$BOT_TOKEN" =~ ^[A-Za-z0-9._-]{50,}$ ]]; then
        print_warning "That doesn't look like a valid Discord bot token."
        echo "Discord bot tokens are long strings with dots (e.g., MTQ5...abc.G1v...xyz)"
        read -p "Try again or press Enter to use it anyway: " NEW_TOKEN
        if [ -n "$NEW_TOKEN" ]; then
            BOT_TOKEN="$NEW_TOKEN"
            continue
        fi
    fi
    break
done

# --- Owner ID with validation ---
echo ""
echo "Now I need your Discord user ID."
echo ""
echo "  1. Open Discord"
echo "  2. Go to Settings → Advanced → Developer Mode → ON"
echo "  3. Right-click your own name in any chat"
echo "  4. Click 'Copy User ID'"
echo ""
read -p "Paste your Discord user ID here: " OWNER_ID

while true; do
    if [ -z "$OWNER_ID" ]; then
        print_error "Owner ID can't be empty"
        read -p "Paste your Discord user ID here: " OWNER_ID
        continue
    fi

    # Discord user IDs are 17-20 digit numbers
    if [[ ! "$OWNER_ID" =~ ^[0-9]{17,20}$ ]]; then
        print_warning "That doesn't look like a Discord user ID."
        echo "Discord user IDs are 17-20 digit numbers (e.g., 123456789012345678)"
        read -p "Try again: " OWNER_ID
        continue
    fi
    break
done

print_success "Discord configured"

# ============================================================
# Step 7: Create Working Directory
# ============================================================

print_step "7/8" "Directories & Optional Model Lanes"

read -p "Working directory for agent projects [$HOME/projects]: " WORKING_DIR
WORKING_DIR="${WORKING_DIR:-$HOME/projects}"
mkdir -p "$WORKING_DIR"
print_success "Working directory: $WORKING_DIR"

# Optional: cheap-model lane API keys (config/models.yaml catalog). All
# skippable — agents stay on the Claude lane until a model is assigned in
# config/models.local.yaml, and startup validation tells you exactly which
# key is missing if you assign one later.
echo ""
echo "Optional model-lane API keys (Enter to skip each — only needed once you"
echo "assign an agent a cheap-model tier in config/models.local.yaml):"
read -p "  OLLAMA_API_KEY (Ollama Cloud — DeepSeek/Kimi lane): " OLLAMA_KEY
read -p "  DEEPSEEK_API_KEY (DeepSeek direct API): " DEEPSEEK_KEY
read -p "  GEMINI_API_KEY (Google Gemini lane): " GEMINI_KEY

# ============================================================
# Step 8: Install & Build
# ============================================================

print_step "8/8" "Installing & Building"

# Create .env
cat > .env << ENVEOF
DISCORD_BOT_TOKEN_HOUSE_MD=$BOT_TOKEN
DISCORD_OWNER_ID=$OWNER_ID
WORKING_DIR=$WORKING_DIR
ENVEOF
[ -n "$OLLAMA_KEY" ] && echo "OLLAMA_API_KEY=$OLLAMA_KEY" >> .env
[ -n "$DEEPSEEK_KEY" ] && echo "DEEPSEEK_API_KEY=$DEEPSEEK_KEY" >> .env
[ -n "$GEMINI_KEY" ] && echo "GEMINI_API_KEY=$GEMINI_KEY" >> .env
print_success "Created .env"

# Install dependencies
echo "Installing dependencies..."
npm install --silent
print_success "Dependencies installed"

# Build
echo "Building..."
npm run build --silent
print_success "Build complete"

# Offline test suite — fast smoke that the install is sound
echo "Running test suite..."
if npm test --silent > /dev/null 2>&1; then
    print_success "All tests pass"
else
    print_warning "Test suite failed — install may still work; run 'npm test' to inspect"
fi

# Materialize House MD's behavior files from templates/house-md/. Agent state
# is OWNER STATE — untracked by design — so a fresh clone has no agents/
# directory at all; templates/ is the tracked factory default. Without an
# IDENTITY.md the bot would boot with an empty personality.
if [ ! -f agents/house-md/IDENTITY.md ]; then
    if [ ! -d templates/house-md ]; then
        print_error "templates/house-md/ missing from this install (packaging defect)."
        echo "  Expected at: $(pwd)/templates/house-md/"
        echo "  Re-clone the repo (or restore templates/), then re-run setup.sh."
        exit 1
    fi
    mkdir -p agents/house-md/memory
    cp -R templates/house-md/. agents/house-md/
    print_success "Materialized agents/house-md/ from templates/house-md/"
else
    print_success "agents/house-md/ already exists — left untouched"
fi

# Whitelist the working directory for agent writes. config/config.yaml ships
# with a /tmp-only placeholder; without this, House MD can't write anywhere.
node -e "
const fs = require('fs');
let t = fs.readFileSync('config/config.yaml', 'utf-8');
const dir = process.argv[1];
if (!t.includes('- ' + dir)) {
  t = t.replace(/^  allowed_paths:\r?\n/m, '  allowed_paths:\n    - ' + dir + '\n');
  fs.writeFileSync('config/config.yaml', t);
}
" "$WORKING_DIR" && print_success "Added $WORKING_DIR to safety.allowed_paths" \
  || print_warning "Could not update safety.allowed_paths — add '$WORKING_DIR' to config/config.yaml manually"

# Install hive CLI. npm link is the nice-to-have path; it FAILS WITH EACCES
# on shared-Homebrew Macs (the npm global root is owned by whichever user
# installed Homebrew, and another account's install may already hold the
# global 'neato-hive' link — overwriting it would hijack THEIR hive command).
# Fall back to a per-user PATH entry pointing at bin/ — same CLI, no global
# state, never sudo, never fatal.
echo "Installing hive CLI..."
GLOBAL_ROOT="$(npm config get prefix 2>/dev/null)/lib/node_modules/neato-hive"
LINK_OK=0
if [ -e "$GLOBAL_ROOT" ] && [ ! -w "$GLOBAL_ROOT" ]; then
    print_warning "Global 'neato-hive' belongs to another user account on this Mac — not touching it."
elif npm link --silent 2>/dev/null; then
    LINK_OK=1
fi
if [ "$LINK_OK" = "1" ] && ensure_npm_global_path hive; then
    print_success "hive CLI installed (try: hive help)"
else
    SHELL_RC="$HOME/.zshrc"
    [[ "$SHELL" == *bash* ]] && SHELL_RC="$HOME/.bashrc"
    if ! grep -q "$(pwd)/bin" "$SHELL_RC" 2>/dev/null; then
        echo "export PATH=\"$(pwd)/bin:\$PATH\"" >> "$SHELL_RC"
    fi
    export PATH="$(pwd)/bin:$PATH"
    print_success "hive CLI on PATH via $(basename "$SHELL_RC") (per-user, no npm link needed)"
fi

# Start House MD
echo "Starting House MD..."
pm2 delete house-md --silent 2>/dev/null || true
pm2 start dist/index.js --name house-md -- --agent house-md
pm2 save --silent 2>/dev/null

# --- Post-start health check ---
echo "Verifying House MD is running..."
sleep 3

# node is guaranteed by step 1 (python3 is not present on minimal installs)
PM2_STATUS=$(pm2 jlist 2>/dev/null | node -e "
let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  try {
    const p = JSON.parse(s).find((x) => x.name === 'house-md');
    console.log(p ? p.pm2_env.status : 'not_found');
  } catch {
    console.log('error');
  }
});
" 2>/dev/null || echo "error")

if [ "$PM2_STATUS" = "online" ]; then
    print_success "House MD is running"
else
    print_error "House MD failed to start (status: $PM2_STATUS)"
    echo ""
    echo "Check the logs for details:"
    echo "  pm2 logs house-md --lines 20 --nostream"
    echo ""
    echo "Common issues:"
    echo "  - 'Credit balance too low' → Run 'claude setup-token' (not API key)"
    echo "  - Bot token invalid → Check your token in .env"
    echo "  - Channel not found → Create #house-md in your Discord server"
    echo ""
fi

# Setup PM2 startup
echo ""
echo "To keep House MD running after reboots, run this command:"
echo ""
pm2 startup | tail -1
echo ""

# ============================================================
# Done
# ============================================================

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}${BOLD}        🐝  Hive is ready!  🐝            ${NC}${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "House MD is online in your Discord server."
echo "Go to the #house-md channel and say hello."
echo ""
echo "House will walk you through building your first agent."
echo ""
echo -e "${BOLD}Quick reference:${NC}"
echo "  hive status             — See running agents"
echo "  hive logs house-md      — View House MD logs"
echo "  hive restart house-md   — Restart House MD"
echo "  hive doctor             — Run health checks"
echo "  hive help               — See all commands"
echo ""
echo -e "${BOLD}In Discord:${NC} /status (tokens, cache, spend) · /swap <model>"
echo "(move an agent to a cheaper model from config/models.yaml) · /newsession"
echo ""
echo "Your Hive lives at: $(pwd)"
echo ""
