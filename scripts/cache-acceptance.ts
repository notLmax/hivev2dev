/**
 * cache-acceptance.ts — Queen Bee live acceptance gate (04 §4):
 *
 *   "Cache test: scripted 10-turn session including 3 memory writes;
 *    assert hit rate ≥80%."
 *
 * Runs a REAL session against the Claude API (needs CLI-managed auth or
 * ANTHROPIC_API_KEY), so it's a runnable script, not a CI test:
 *
 *   npm run test:cache            (defaults: claude-sonnet-4-6, 10 turns)
 *   npm run test:cache -- --model claude-opus-4-8 --turns 10
 *
 * What it does:
 *   1. Builds a throwaway fixture agent in os.tmpdir() — AgentConfig is
 *      constructed directly, zero coupling to config.yaml or this repo's
 *      agent roster; agents/ is never touched.
 *   2. Runs N sequential runAgent() turns, threading sessionId.
 *   3. Before turns 4, 6 and 9 the SCRIPT appends to the fixture's TASKS.md
 *      and daily memory — deterministic WAL simulation, no reliance on model
 *      behavior.
 *   4. Aggregates per-turn cacheRead/(cacheRead+cacheCreate) over turns 2..N
 *      (turn 1 is the expected cold cache creation) and asserts ≥ 0.80.
 *
 * Note: the fixture IDENTITY.md is padded so the prefix clears the model's
 * minimum cacheable length (Sonnet 4.6: 1024 tokens; Haiku 4.5 needs 4096 —
 * don't run this against Haiku and expect a meaningful number).
 */

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgent, type AgentConfig } from "../src/core/agent.js";
import { DEFAULT_STATE_HEADER_CONFIG } from "../src/core/state-header.js";

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const MODEL = argValue("--model") ?? "claude-sonnet-4-6";
const TURNS = Number(argValue("--turns") ?? 10);
const THRESHOLD = Number(argValue("--threshold") ?? 0.8);
const WAL_WRITE_BEFORE_TURNS = new Set([4, 6, 9]);

// Computed ONCE — a run spanning midnight must not flake.
const TODAY = new Date().toISOString().slice(0, 10);

function buildFixture(): { root: string; config: AgentConfig } {
  const root = mkdtempSync(join(tmpdir(), "hive-cache-acceptance-"));
  const behaviorDir = join(root, "agents", "cache-probe");
  const memoryDir = join(behaviorDir, "memory");
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });

  // Pad the static prefix past the model's minimum cacheable length.
  const padding = Array.from(
    { length: 120 },
    (_, i) =>
      `- Operating note ${i}: keep replies minimal during diagnostics; this line exists to give the cacheable prefix realistic size.`
  ).join("\n");
  writeFileSync(
    join(behaviorDir, "IDENTITY.md"),
    `# Identity\n\nYou are cache-probe, a diagnostic agent. Reply with exactly what you are asked to reply with — nothing else.\n\n${padding}`
  );
  writeFileSync(join(behaviorDir, "TASKS.md"), "# Tasks\n\n- [ ] baseline task");
  writeFileSync(join(memoryDir, `${TODAY}.md`), "- session start");

  const config: AgentConfig = {
    name: "cache-probe",
    behaviorDir,
    memoryDir,
    model: MODEL,
    workingDir: root,
    codex: { enabled: false, command: "", args: [] },
    browser: { enabled: false },
    webhookIngress: { allowedIds: [] },
    safety: {
      blocked_commands: ["rm -rf /"],
      allowed_paths: [root],
      protected_paths: [],
    },
    runtime: "claude-agent-sdk",
    stateHeader: { ...DEFAULT_STATE_HEADER_CONFIG, includeCodexTasks: false },
  };
  return { root, config };
}

interface TurnRow {
  query: number;
  turn: number;
  input: number;
  cacheRead: number;
  cacheCreate: number;
  walWrite: boolean;
}

async function main(): Promise<void> {
  const { root, config } = buildFixture();
  console.log(`[cache-acceptance] model=${MODEL} turns=${TURNS} threshold=${THRESHOLD}`);
  console.log(`[cache-acceptance] fixture: ${root}`);

  const rows: TurnRow[] = [];
  let sessionId: string | undefined;

  try {
    for (let q = 1; q <= TURNS; q++) {
      const walWrite = WAL_WRITE_BEFORE_TURNS.has(q);
      if (walWrite) {
        // Deterministic WAL simulation: mutate state BETWEEN queries, exactly
        // like an agent writing memory/tasks before its next turn.
        appendFileSync(join(config.behaviorDir, "TASKS.md"), `\n- [ ] task added before query ${q}`);
        appendFileSync(join(config.memoryDir, `${TODAY}.md`), `\n- memory appended before query ${q}`);
        console.log(`[cache-acceptance] WAL write before query ${q}`);
      }

      const result = await runAgent(
        `Diagnostic query ${q}. Reply with exactly: OK`,
        config,
        () => {}, // discard messages — usage is what we're here for
        async () => false,
        sessionId
      );
      sessionId = result.sessionId ?? sessionId;

      for (const t of result.turns ?? []) {
        rows.push({
          query: q,
          turn: t.turn,
          input: t.input,
          cacheRead: t.cacheRead,
          cacheCreate: t.cacheCreate,
          walWrite,
        });
      }
      if (!result.turns || result.turns.length === 0) {
        console.error(`[cache-acceptance] query ${q}: no turn usage captured — check auth/model`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (rows.length === 0) {
    console.error("FAIL: no usage captured at all (auth missing? model unavailable?)");
    process.exit(1);
  }

  console.log("\nquery  turn  input  cacheRead  cacheCreate  hit%   wal");
  for (const r of rows) {
    const total = r.cacheRead + r.cacheCreate;
    const hit = total > 0 ? `${Math.round((r.cacheRead / total) * 100)}%` : "—";
    console.log(
      `${String(r.query).padEnd(6)} ${String(r.turn).padEnd(5)} ${String(r.input).padEnd(6)} ` +
        `${String(r.cacheRead).padEnd(10)} ${String(r.cacheCreate).padEnd(12)} ${hit.padEnd(6)} ${r.walWrite ? "←write" : ""}`
    );
  }

  // Turn 1 of query 1 is the expected cold creation — excluded by the gate.
  const scored = rows.filter((r) => r.query >= 2);
  const read = scored.reduce((a, r) => a + r.cacheRead, 0);
  const create = scored.reduce((a, r) => a + r.cacheCreate, 0);
  const ratio = read + create > 0 ? read / (read + create) : 0;

  console.log(`\nAggregate (queries 2..${TURNS}): cacheRead=${read} cacheCreate=${create} hit=${(ratio * 100).toFixed(1)}%`);
  if (ratio >= THRESHOLD) {
    console.log(`PASS: ${(ratio * 100).toFixed(1)}% ≥ ${THRESHOLD * 100}% (Queen Bee gate, 04 §4)`);
  } else {
    console.error(`FAIL: ${(ratio * 100).toFixed(1)}% < ${THRESHOLD * 100}% (Queen Bee gate, 04 §4)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[cache-acceptance] fatal:", err);
  process.exit(1);
});
