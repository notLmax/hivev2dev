/**
 * spend-rollup.ts — per-agent daily/monthly USD rollup (04 §5).
 *
 * One JSON file per agent under data/spend/ — per-agent files eliminate
 * write races between PM2 processes (each agent process only writes its own).
 * "Daily" and "monthly" use the box's LOCAL date — caps are an operator
 * concept, and the operator lives in local time.
 *
 * usage.jsonl remains the ground truth; this is a cheap materialized view.
 * If a rollup file is corrupted, it self-heals to zeros (conservative for
 * warnings, permissive for stops — acceptable: usage.jsonl still has truth).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface SpendState {
  agent: string;
  daily: { date: string; usd: number; queries: number };
  monthly: { month: string; usd: number };
  /** Dedup marker: last local date a cap warning was posted, per level. */
  warnedAt?: { daily?: string; monthly?: string };
}

export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function localMonth(now: Date = new Date()): string {
  return localDate(now).slice(0, 7);
}

function spendDir(dataDir?: string): string {
  return join(dataDir ?? join(process.cwd(), "data"), "spend");
}

function spendFile(agent: string, dataDir?: string): string {
  // Agent names come from config keys (kebab-case); sanitize defensively.
  const safe = agent.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(spendDir(dataDir), `${safe}.json`);
}

function freshState(agent: string, now: Date): SpendState {
  return {
    agent,
    daily: { date: localDate(now), usd: 0, queries: 0 },
    monthly: { month: localMonth(now), usd: 0 },
  };
}

/** Reads an agent's spend state, rolling over day/month boundaries. */
export function getSpend(agent: string, dataDir?: string, now: Date = new Date()): SpendState {
  let state: SpendState;
  try {
    const raw = JSON.parse(readFileSync(spendFile(agent, dataDir), "utf-8")) as SpendState;
    state = raw && raw.daily && raw.monthly ? raw : freshState(agent, now);
  } catch {
    state = freshState(agent, now);
  }
  // Roll over boundaries on read so callers always see current-window numbers.
  if (state.daily.date !== localDate(now)) {
    state.daily = { date: localDate(now), usd: 0, queries: 0 };
  }
  if (state.monthly.month !== localMonth(now)) {
    state.monthly = { month: localMonth(now), usd: 0 };
  }
  return state;
}

function save(state: SpendState, dataDir?: string): void {
  try {
    const dir = spendDir(dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(spendFile(state.agent, dataDir), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[spend] Failed to save rollup for ${state.agent}:`, err);
  }
}

/** Adds a query's cost. Never throws — billing must not kill a turn. */
export function addSpend(agent: string, usd: number, dataDir?: string, now: Date = new Date()): SpendState {
  const state = getSpend(agent, dataDir, now);
  if (Number.isFinite(usd) && usd > 0) {
    state.daily.usd += usd;
    state.monthly.usd += usd;
  }
  state.daily.queries += 1;
  save(state, dataDir);
  return state;
}

/** Marks a cap warning as posted (dedup: once per level per local day). */
export function markWarned(
  agent: string,
  level: "daily" | "monthly",
  dataDir?: string,
  now: Date = new Date()
): void {
  const state = getSpend(agent, dataDir, now);
  state.warnedAt = { ...state.warnedAt, [level]: localDate(now) };
  save(state, dataDir);
}

/** All agents' spend states (for fleet/status reporting). */
export function getFleetSpend(dataDir?: string, now: Date = new Date()): SpendState[] {
  const dir = spendDir(dataDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => getSpend(f.replace(/\.json$/, ""), dataDir, now));
  } catch {
    return [];
  }
}
