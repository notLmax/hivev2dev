# macOS Test Plan — separate user account, staging repo

Runs the DEPLOYMENT.md §0.3 blocking items on a real Mac using a throwaway
user account and the private staging repo (`notLmax/hivev2dev`, remote name
`dev` on the dev box). Two installs get exercised: a **fresh v2 install**
and a **realistic v1 install that migrates** — plus `hive update` within v2.

**One fact that shapes the whole plan:** v1 → v2 does NOT happen via
`hive update`, for two independent reasons:

1. v1.5.x's `hive update` was cut over (v1.5.0) from git-pull to a
   **website-tarball overlay** — it fetches `/api/current` from the v1
   website and never looks at GitHub. Pushing v2 anywhere has no effect on
   what a v1 user's `hive update` does.
2. Even git-based updating couldn't cross the boundary — the repos share
   zero commit objects.

The only v1 → v2 path is `scripts/migrate-from-v1.sh` (Phase D below).
`hive update` IS tested, but **within v2** (Phase E), where it does a
fetch + selective `git checkout origin/main -- <framework paths>` — no
merge, so it survives the force-pushed orphan re-cuts staging uses.

Budget: ~1.5–2 hours including the v1 fixture install.

---

## Phase A — Create the test account

GUI: System Settings → Users & Groups → Add User… → **Standard** →
name `hivetest`, set a password. Or CLI from your admin account:

```bash
sudo sysadminctl -addUser hivetest -fullName "Hive Test" -password 'pick-one'
```

Log into it (fast user switching is fine — ⌘ menu bar → hivetest). Why a
fresh account is the right sandbox: virgin `$HOME` (no `~/.claude` auth, no
`~/.pm2`, no npm globals, no shell-profile contamination), per-user PM2
daemon and launchd LaunchAgent — your own account's hive is untouched.
What it does NOT isolate: system-wide Xcode CLT and `/opt/homebrew`
(representative of an employee Mac, but not of a literally blank machine).

Prereqs inside the account — follow README “Prerequisites” (macOS block).
Note Homebrew's shellenv won't be in the fresh account's `.zprofile`; add
`eval "$(/opt/homebrew/bin/brew shellenv)"` if `node` isn't found.

GitHub access: the staging repo is private — first clone pops the Git
Credential Manager browser flow, or use a fine-grained PAT scoped to
`hivev2dev` (cleaner: the test account never holds your full login).

Shared-Homebrew caveat (FOUND in the first live Phase B run): `/opt/homebrew`
is owned by whichever account installed Homebrew, so `npm install -g` /
`npm link` from the test account hits `EACCES` — and if the main account
runs a v1 hive, the global `neato-hive` link is THEIRS (overwriting it
would hijack their `hive` command). setup.sh detects this and falls back to
a per-user PATH entry; expect "hive CLI on PATH via .zshrc" instead of an
npm link on such machines. Never `sudo npm link`.

Discord: use a **test guild** and a **throwaway bot token**, per §0.3.

---

## Phase B — Fresh v2 install (§0.3: macOS pass + wizard + Discord smoke)

```bash
git clone https://github.com/notLmax/hivev2dev.git hive && cd hive
bash scripts/install-test.sh all        # harness first — it self-sandboxes
bash setup.sh                           # then the wizard for real
```

Verify per README “Verify the install”: `hive doctor`, `hive status`,
message `#house-md`. Then the Discord smoke from §0.3:

- message → reply with personality + Session State (House MD should follow
  templates/house-md BOOTSTRAP: ask your name first)
- `/status` → cache trend + spend lines
- `/newsession` → next message starts fresh, memory survives
- `/swap model:ollama-deepseek` (needs `OLLAMA_API_KEY`, post-rotation) →
  converse → check handoff note in today's daily memory → `/swap` back
- spend caps: `caps: { daily_usd: 0.05 }` on the test agent in
  `config/models.local.yaml`, restart, drive past 80% (one warn) then 100%
  (hard stop, no dispatch)
- `bin/hive` command sweep (BSD sed/grep risk): status, list, info, logs,
  session, newsession, config, env, doctor
- reboot (or log out/in) → launchd persistence: agent comes back

## Phase C — Build the v1 fixture (realistic legacy user, Claude-only)

Still in the test account, install **v1 from the original repo** exactly
like a legacy user has it:

```bash
cd ~ && git clone https://github.com/notLmax/neatohive.git neato-hive
cd neato-hive && ./setup.sh             # v1's own wizard (second throwaway bot token)
```

Make it look lived-in — that's what migration must preserve:

- House MD + at least one more agent (let v1 House MD build a generalist,
  or copy a v1 template into `agents/` + add to v1's config.yaml roster)
- all agents on Claude models (v1 default) — this is the
  passthrough-verification population
- talk to each agent enough to write real state: a MEMORY.md entry, a task
  in TASKS.md, a daily memory file
- optional realism: run v1's `hive update` once and observe it talk to the
  website updater (it updates v1 only, or no-ops — proves point 1 above)

> §0.3 also wants this against a **copy of a real employee install**, which
> exercises legacy config.yaml keys (users.local.yaml, dashboard settings)
> the fixture won't have. This fixture pass is necessary, not sufficient —
> repeat Phase D against a real copy before waves.

## Phase D — Migration test (§0.3: migration dry-run)

From anywhere in the test account:

```bash
cd ~/hive   # the Phase B clone (or any v2 checkout — script clones fresh anyway)
bash scripts/migrate-from-v1.sh --old ~/neato-hive --repo https://github.com/notLmax/hivev2dev.git --dest ~/hive2
```

Watch for, in order: checksummed backup manifest (non-empty), fresh clone +
green build/tests, transplant, roster + safety-path merge, **byte-identical
verification**, printed PM2 cutover commands. Stop v1's PM2 processes, run
the cutover, then verify per DEPLOYMENT.md §1.5:

- each migrated agent replies with its OLD personality + memory
- models unchanged (passthrough — no catalog assignment exists yet)
- `/status` shows the new cache/spend lines; second message onward the
  cache trend climbs
- review the merged `config/config.yaml` once (merge drops inline comments)

Rollback rehearsal (optional but cheap): `pm2 delete all`, start the old
processes from `~/neato-hive`, confirm v1 still works untouched.

## Phase E — `hive update` within v2 (staging re-cut → user pulls)

On the **dev box**: make a trivial framework change on `v2` (e.g. a README
line), commit, re-cut `release` + retag, `git push dev release:main --force`
(+ tag `--force`).

On the **Mac test account**, in the migrated install (`~/hive2`):

```bash
hive update
```

Expected: fetch succeeds despite the unrelated orphan root (no merge —
selective checkout), each framework path prints `Updated:`, npm install +
rebuild, agents restart, and `agents/`, `.env`, `data/`,
`config/config.yaml`, `config/models.local.yaml` are byte-identical to
before (spot-check with `shasum`). Since the 2026-06-11 fix, the framework
list includes `shared/`, `skills/`, `scripts/`, `docs/`, `templates/`,
`tests/`, and `config/models.yaml` (catalog repins propagate) — verify your
trivial change arrived AND that `config/config.yaml` did NOT change.

## Phase F — Cleanup

```bash
pm2 unstartup   # removes the per-user LaunchAgent
pm2 delete all
```

Revoke both throwaway bot tokens, revoke the PAT if used, then System
Settings → Users & Groups → delete the `hivetest` account (erase home
folder).

---

## Results ledger

Record pass/fail per phase against DEPLOYMENT.md §0.3 and append findings
to the CLAUDE.md work-state ledger. Anything that fails here blocks pilot
migrations.
