#!/usr/bin/env node
/**
 * cache-report.mjs — Queen Bee KPI report (04 §4.0).
 *
 * Reads data/usage.jsonl (per-query) and data/turns.jsonl (per-turn) and prints:
 *   - per-agent cache hit % (cacheRead / (cacheRead + cacheCreate)), per day
 *   - prompt-hash change events, annotated:
 *       expected      — a behavior/shared fileHash changed alongside it
 *       accidental ⚠  — promptHash changed but no fileHash did (churn; known
 *                       exception: deploys that change static sections)
 *   - per-file churn table: distinct content hashes per behavior file per day —
 *     the data that validates (or rolls back) mutable-file eviction (04 §4.2)
 *
 * Zero dependencies, runs on Windows and Unix. Tolerates legacy lines that
 * lack the new optional fields.
 *
 * Usage: node scripts/cache-report.mjs [--agent <name>] [--days <N>] [--data <dir>]
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const agentFilter = argValue("--agent");
const days = Number(argValue("--days") ?? 14);
const dataDir = argValue("--data") ?? join(process.cwd(), "data");

function readJsonl(file) {
  const path = join(dataDir, file);
  if (!existsSync(path)) return [];
  const records = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // tolerate torn/legacy lines
    }
  }
  return records;
}

const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const day = (ts) => (ts ?? "").slice(0, 10);
const pct = (read, create) => {
  const total = read + create;
  return total > 0 ? `${Math.round((read / total) * 100)}%` : "—";
};

const queries = readJsonl("usage.jsonl").filter(
  (r) => (!agentFilter || r.agent === agentFilter) && new Date(r.timestamp ?? 0) >= cutoff
);
const turns = readJsonl("turns.jsonl").filter(
  (r) => (!agentFilter || r.agent === agentFilter) && new Date(r.ts ?? 0) >= cutoff
);

if (queries.length === 0 && turns.length === 0) {
  console.log(`No telemetry in ${dataDir} for the last ${days} day(s)${agentFilter ? ` (agent: ${agentFilter})` : ""}.`);
  process.exit(0);
}

// ── 1. Per-agent / per-day hit rate ─────────────────────────────────────────
console.log(`\n═══ Cache hit rate (last ${days}d${agentFilter ? `, agent: ${agentFilter}` : ""}) ═══\n`);

const byAgent = new Map();
for (const q of queries) {
  const key = q.agent ?? "?";
  if (!byAgent.has(key)) byAgent.set(key, []);
  byAgent.get(key).push(q);
}

for (const [agent, qs] of [...byAgent.entries()].sort()) {
  const read = qs.reduce((a, q) => a + (q.cacheReadTokens ?? 0), 0);
  const create = qs.reduce((a, q) => a + (q.cacheCreationTokens ?? 0), 0);
  const cost = qs.reduce((a, q) => a + (q.costUSD ?? 0), 0);
  console.log(`${agent}: ${qs.length} queries · hit ${pct(read, create)} · $${cost.toFixed(2)}`);

  const byDay = new Map();
  for (const q of qs) {
    const d = day(q.timestamp);
    if (!byDay.has(d)) byDay.set(d, { read: 0, create: 0, n: 0 });
    const acc = byDay.get(d);
    acc.read += q.cacheReadTokens ?? 0;
    acc.create += q.cacheCreationTokens ?? 0;
    acc.n++;
  }
  for (const [d, acc] of [...byDay.entries()].sort()) {
    console.log(`  ${d}: ${pct(acc.read, acc.create)} hit over ${acc.n} queries`);
  }
}

// Per-turn aggregate (finer-grained than per-query — the actual KPI)
if (turns.length > 0) {
  const tRead = turns.reduce((a, t) => a + (t.cacheRead ?? 0), 0);
  const tCreate = turns.reduce((a, t) => a + (t.cacheCreate ?? 0), 0);
  console.log(`\nPer-turn aggregate: ${turns.length} turns · hit ${pct(tRead, tCreate)}`);
}

// ── 2. Prompt-hash change events ─────────────────────────────────────────────
console.log(`\n═══ Prompt-hash changes ═══\n`);

let events = 0;
for (const [agent, qs] of [...byAgent.entries()].sort()) {
  const ordered = qs
    .filter((q) => q.promptHash)
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  let prev = null;
  for (const q of ordered) {
    if (prev && q.promptHash !== prev.promptHash) {
      events++;
      const changedFiles = Object.entries(q.fileHashes ?? {})
        .filter(([f, h]) => (prev.fileHashes ?? {})[f] !== h)
        .map(([f]) => f);
      const removed = Object.keys(prev.fileHashes ?? {}).filter(
        (f) => !(q.fileHashes ?? {})[f]
      );
      const all = [...changedFiles, ...removed.map((f) => `${f} (removed)`)];
      const verdict = all.length > 0 ? `expected — ${all.join(", ")}` : "accidental churn ⚠";
      console.log(`${q.timestamp} ${agent}: ${prev.promptHash} → ${q.promptHash} [${verdict}]`);
    }
    prev = q;
  }
}
if (events === 0) console.log("No prompt-hash changes recorded (or telemetry too new).");

// ── 3. Per-file churn table ──────────────────────────────────────────────────
console.log(`\n═══ Behavior-file churn (distinct hashes per day) ═══\n`);

const churn = new Map(); // "agent|file" -> Map<day, Set<hash>>
for (const q of queries) {
  for (const [file, hash] of Object.entries(q.fileHashes ?? {})) {
    const key = `${q.agent}|${file}`;
    if (!churn.has(key)) churn.set(key, new Map());
    const dayMap = churn.get(key);
    const d = day(q.timestamp);
    if (!dayMap.has(d)) dayMap.set(d, new Set());
    dayMap.get(d).add(hash);
  }
}

let churnRows = 0;
for (const [key, dayMap] of [...churn.entries()].sort()) {
  const versions = [...dayMap.values()].reduce((a, s) => a + s.size, 0);
  const daysSeen = dayMap.size;
  if (versions > daysSeen) {
    // more distinct versions than days = intra-day churn → cache-relevant
    const [agent, file] = key.split("|");
    const detail = [...dayMap.entries()]
      .sort()
      .map(([d, s]) => `${d}:${s.size}`)
      .join(" ");
    console.log(`${agent} ${file}: ${versions} versions over ${daysSeen} day(s) → ${detail}`);
    churnRows++;
  }
}
if (churnRows === 0) {
  console.log("No intra-day file churn observed (1 version/file/day or telemetry too new).");
}

// ── 4. Context editing (SDK compaction / compat client-budget trims) ─────────
console.log(`\n═══ Context editing ═══\n`);

let editRows = 0;
for (const [agent, qs] of [...byAgent.entries()].sort()) {
  const compactions = qs.reduce((a, q) => a + (q.compactions ?? 0), 0);
  const pruned = qs.reduce((a, q) => a + (q.prunedToolResults ?? 0), 0);
  const dropped = qs.reduce((a, q) => a + (q.droppedMessages ?? 0), 0);
  if (compactions + pruned + dropped === 0) continue;
  const edited = qs.filter(
    (q) => (q.compactions ?? 0) + (q.prunedToolResults ?? 0) + (q.droppedMessages ?? 0) > 0
  ).length;
  console.log(
    `${agent}: ${compactions} compaction(s) · ${pruned} tool result(s) pruned · ` +
    `${dropped} message(s) dropped · ${edited}/${qs.length} queries edited`
  );
  editRows++;
}
if (editRows === 0) {
  console.log("No context edits recorded — no SDK compactions, no client-budget trims.");
} else {
  console.log("\nNote: a compaction rewrites the transcript, so a low cache ratio on the");
  console.log("turn after one is EXPECTED (messages bust; the prompt prefix survives).");
}
console.log("");
