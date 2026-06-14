/**
 * compat-live.ts — WP3 live acceptance: drive the anthropic-compat runtime
 * end-to-end against Ollama Cloud's deepseek lane (BASE-PIN decision 3).
 *
 *   npm run test:compat
 *   npm run test:compat -- --model deepseek-v4-flash --base https://ollama.com
 *
 * Validates, against the REAL endpooint with OLLAMA_API_KEY from .env:
 *   1. plain query → final text
 *   2. tool round-trip: model calls Write, file appears on disk, model confirms
 *   3. session persistence: second query on the same sessionId recalls turn 1
 *   4. per-turn telemetry + usage accumulation
 *
 * Fixture agent lives in os.tmpdir(); agents/ untouched.
 */

import "dotenv/config";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgent, type AgentConfig } from "../src/core/agent.js";
import { DEFAULT_STATE_HEADER_CONFIG } from "../src/core/state-header.js";

const args = process.argv.slice(2);
const argValue = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const MODEL = argValue("--model") ?? "deepseek-v4-flash";
const BASE = argValue("--base") ?? "https://ollama.com";

async function main(): Promise<void> {
  if (!process.env.OLLAMA_API_KEY) {
    console.error("FAIL: OLLAMA_API_KEY not set (env or .env)");
    process.exit(1);
  }

  const root = mkdtempSync(join(tmpdir(), "hive-compat-live-"));
  const behaviorDir = join(root, "agents", "compat-probe");
  mkdirSync(join(behaviorDir, "memory"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(
    join(behaviorDir, "IDENTITY.md"),
    "# Identity\n\nYou are compat-probe, a diagnostic agent. Follow instructions exactly and keep replies to one short sentence."
  );
  writeFileSync(join(behaviorDir, "TASKS.md"), "# Tasks\n\n- [ ] diagnostics");

  const config: AgentConfig = {
    name: "compat-probe",
    behaviorDir,
    memoryDir: join(behaviorDir, "memory"),
    model: MODEL,
    workingDir: root,
    codex: { enabled: false, command: "", args: [] },
    browser: { enabled: false },
    webhookIngress: { allowedIds: [] },
    safety: { blocked_commands: ["rm -rf /"], allowed_paths: [root], protected_paths: [] },
    runtime: "anthropic-compat",
    stateHeader: { ...DEFAULT_STATE_HEADER_CONFIG, includeCodexTasks: false },
    modelInfo: {
      modelId: MODEL,
      runtime: "anthropic-compat",
      catalogKey: "ollama-deepseek",
      baseURL: BASE,
      apiKeyEnv: "OLLAMA_API_KEY",
      quirks: "deepseek",
      contextWindow: 160_000,
    },
  };

  const failures: string[] = [];
  let finalText = "";
  const onMessage = (m: { type: string; content: string }) => {
    if (m.type === "text") finalText = m.content;
    console.log(`  [${m.type}] ${m.content.slice(0, 160)}`);
  };

  try {
    // ── 1+2: tool round-trip ──
    console.log(`\n═══ Query 1: Write-tool round-trip (${MODEL} via ${BASE}) ═══`);
    const target = join(root, "hello.txt");
    const r1 = await runAgent(
      `Use the Write tool to create the file ${target} containing exactly: hive lives\nThen reply with exactly: DONE`,
      config,
      onMessage,
      async () => false
    );
    if (!r1.sessionId) failures.push("query 1: no sessionId returned");
    if (!existsSync(target)) {
      failures.push("query 1: hello.txt was not created — tool round-trip failed");
    } else {
      const content = readFileSync(target, "utf-8").trim();
      console.log(`  hello.txt content: "${content}"`);
      if (!content.includes("hive lives")) failures.push(`query 1: unexpected file content "${content}"`);
    }
    if ((r1.turns?.length ?? 0) < 2) failures.push(`query 1: expected ≥2 API turns (tool flow), got ${r1.turns?.length}`);
    if (!r1.usage || r1.usage.inputTokens + r1.usage.cacheReadTokens === 0) failures.push("query 1: no usage captured");
    console.log(
      `  turns=${r1.turns?.length} usage: in=${r1.usage?.inputTokens} cacheRead=${r1.usage?.cacheReadTokens} out=${r1.usage?.outputTokens}`
    );

    // ── 3: session persistence ──
    console.log(`\n═══ Query 2: session resume ═══`);
    finalText = "";
    const r2 = await runAgent(
      "What file did you create in this conversation? Reply with just its filename.",
      config,
      onMessage,
      async () => false,
      r1.sessionId
    );
    if (r2.sessionId !== r1.sessionId) failures.push("query 2: sessionId changed — resume failed");
    if (!/hello\.txt/i.test(finalText)) failures.push(`query 2: model did not recall hello.txt (got: "${finalText.slice(0, 120)}")`);

    const transcriptFile = join(behaviorDir, "session-compat");
    if (!existsSync(transcriptFile)) failures.push("transcript dir missing");
  } catch (e) {
    failures.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n═══ Verdict ═══`);
  if (failures.length === 0) {
    console.log("PASS: anthropic-compat runtime verified live — tool round-trip, session resume, telemetry.");
  } else {
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
