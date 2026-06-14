/**
 * Telemetry appender tests (Queen Bee 04 §4.0).
 * Uses an injected temp dataDir — never the repo's data/.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  appendTurnUsage,
  appendQueryUsage,
  computeCacheRatio,
  type TurnUsageRecord,
  type QueryUsageRecord,
} from "../src/core/telemetry.js";

let dataDir: string;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), "hive-telemetry-")), "data");
});

afterEach(() => {
  rmSync(join(dataDir, ".."), { recursive: true, force: true });
});

describe("computeCacheRatio", () => {
  it("is null when there is no cache traffic", () => {
    expect(computeCacheRatio(0, 0)).toBeNull();
  });
  it("computes read/(read+create)", () => {
    expect(computeCacheRatio(9000, 1000)).toBeCloseTo(0.9);
    expect(computeCacheRatio(0, 500)).toBe(0);
    expect(computeCacheRatio(500, 0)).toBe(1);
  });
});

describe("appendTurnUsage / appendQueryUsage", () => {
  it("creates the dataDir and appends parseable JSONL", () => {
    const turn: TurnUsageRecord = {
      ts: "2026-06-10T12:00:00Z",
      agent: "test-agent",
      queryId: "q-abc123",
      sessionId: "s-1",
      turn: 1,
      input: 100,
      cacheRead: 9000,
      cacheCreate: 1000,
      ratio: 0.9,
    };
    appendTurnUsage(turn, dataDir);
    appendTurnUsage({ ...turn, turn: 2, ratio: null }, dataDir);

    const lines = readFileSync(join(dataDir, "turns.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(turn);
    expect(JSON.parse(lines[1]).ratio).toBeNull();
  });

  it("round-trips a query record with legacy + new fields", () => {
    const rec: QueryUsageRecord = {
      timestamp: "2026-06-10T12:00:00Z",
      agent: "test-agent",
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 9000,
      cacheCreationTokens: 1000,
      costUSD: 0.05,
      numTurns: 3,
      durationMs: 4000,
      queryId: "q-abc123",
      promptHash: "deadbeef0123",
      promptChars: 34000,
      headerChars: 1200,
      sectionHashes: { identity: "aaa" },
      fileHashes: { "IDENTITY.md": "bbb", "MEMORY.md": "ccc" },
      // Context-editing fields (04 §4.8)
      compactions: 1,
      compactionPreTokens: 150_000,
      prunedToolResults: 4,
      droppedMessages: 12,
    };
    appendQueryUsage(rec, dataDir);
    const parsed = JSON.parse(readFileSync(join(dataDir, "usage.jsonl"), "utf-8").trim());
    expect(parsed).toEqual(rec);
    // Legacy reader contract: the original field names exist.
    for (const k of [
      "timestamp", "agent", "inputTokens", "outputTokens",
      "cacheReadTokens", "cacheCreationTokens", "costUSD", "numTurns", "durationMs",
    ]) {
      expect(parsed).toHaveProperty(k);
    }
  });

  it("never throws on unwritable destinations", () => {
    // A FILE where the directory should be → mkdir fails internally.
    const bogus = join(dataDir, "..", "blocking-file");
    mkdirSync(join(dataDir, ".."), { recursive: true });
    writeFileSync(bogus, "i am a file, not a directory");
    appendQueryUsage(
      { timestamp: "t", agent: "a" } as unknown as QueryUsageRecord,
      join(bogus, "nested")
    );
    expect(existsSync(join(bogus, "nested"))).toBe(false);
  });
});
