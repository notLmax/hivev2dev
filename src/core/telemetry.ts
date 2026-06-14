/**
 * telemetry.ts — Queen Bee step 0 (04 §4.0): persistent cache telemetry.
 *
 * Two append-only JSONL files under data/:
 *
 *   turns.jsonl — one record per assistant turn (per API call). The per-turn
 *   cache read:create ratio is the Queen Bee KPI: every prompt-assembly change
 *   is judged against it.
 *
 *   usage.jsonl — one record per query. Pre-existing file: the legacy fields
 *   keep their exact names and types (external readers stay compatible); new
 *   fields are optional additions. promptHash/sectionHashes/fileHashes let the
 *   cache report distinguish EXPECTED prefix changes (a behavior file was
 *   edited — some fileHash changed too) from ACCIDENTAL churn (promptHash
 *   changed, no fileHash did).
 *
 * Telemetry must never kill a turn: every append is try/caught and failures
 * degrade to a console line.
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

/** One record per assistant turn (per API call within a query). */
export interface TurnUsageRecord {
  ts: string;
  agent: string;
  /** Correlates turns to their usage.jsonl query record. */
  queryId: string;
  sessionId?: string;
  /** 1-based index of the turn within the query. */
  turn: number;
  /** Uncached input tokens for this API call. */
  input: number;
  cacheRead: number;
  cacheCreate: number;
  /** cacheRead / (cacheRead + cacheCreate); null when both are 0. */
  ratio: number | null;
}

/** One record per query. Legacy fields first — names must not change. */
export interface QueryUsageRecord {
  timestamp: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  numTurns: number;
  durationMs: number;
  // ── Optional additions (Queen Bee 04 §4.0; billing 04 §5) ──
  queryId?: string;
  sessionId?: string;
  model?: string;
  runtime?: string;
  catalogKey?: string;
  tier?: string;
  /** Catalog-priced cost (src/billing/pricing.ts). */
  costUsdComputed?: number;
  /** The runtime's client-side estimate (SDK total_cost_usd / ADK table). */
  costUsdReported?: number;
  /** sha256[0:12] of the assembled system prompt. */
  promptHash?: string;
  promptChars?: number;
  /** Size of the per-message Session State header (04 §4.2), once it exists. */
  headerChars?: number;
  /** Hashes of non-file prompt sections: identity, toolGuidance, skills, safety. */
  sectionHashes?: Record<string, string>;
  /** Hashes of every behavior/shared file — including evicted ones (churn meter). */
  fileHashes?: Record<string, string>;
  // ── Context-editing telemetry (04 §4.8; doc 03 §3) ──
  /** SDK auto-compaction events during this query (claude lane). */
  compactions?: number;
  /** pre_tokens reported by the most recent compact_boundary (claude lane). */
  compactionPreTokens?: number;
  /** Tool-result bodies replaced by the client context budget (compat lane). */
  prunedToolResults?: number;
  /** Whole messages dropped by the client context budget (compat lane). */
  droppedMessages?: number;
}

export function computeCacheRatio(cacheRead: number, cacheCreate: number): number | null {
  const total = cacheRead + cacheCreate;
  if (total <= 0) return null;
  return cacheRead / total;
}

function appendJsonl(file: string, record: unknown, dataDir?: string): void {
  try {
    const dir = dataDir ?? join(process.cwd(), "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), JSON.stringify(record) + "\n");
  } catch (err) {
    console.error(`[telemetry] Failed to append ${file}:`, err);
  }
}

/** Appends a per-turn record to data/turns.jsonl. Never throws. */
export function appendTurnUsage(rec: TurnUsageRecord, dataDir?: string): void {
  appendJsonl("turns.jsonl", rec, dataDir);
}

/** Appends a per-query record to data/usage.jsonl. Never throws. */
export function appendQueryUsage(rec: QueryUsageRecord, dataDir?: string): void {
  appendJsonl("usage.jsonl", rec, dataDir);
}
