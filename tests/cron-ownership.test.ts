/**
 * Cron per-agent ownership (audit blocker 4).
 * Each agent process must only see/fire its own jobs; jobs require an owner.
 * Uses env-overridable cron paths to isolate to a temp file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  cronAdd,
  cronList,
  cronListForAgent,
  _resetCronForTesting,
} from "../src/tools/cron.js";

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hive-cron-"));
  savedEnv.HIVE_CRON_FILE = process.env.HIVE_CRON_FILE;
  savedEnv.HIVE_CRON_LOG_DIR = process.env.HIVE_CRON_LOG_DIR;
  savedEnv.HIVE_AGENT_NAME = process.env.HIVE_AGENT_NAME;
  process.env.HIVE_CRON_FILE = join(dir, "cron-jobs.json");
  process.env.HIVE_CRON_LOG_DIR = join(dir, "cron-logs");
  // A non-matching owner so cronAdd's startJob never schedules a live task.
  process.env.HIVE_AGENT_NAME = "test-orchestrator-none";
});

afterEach(() => {
  _resetCronForTesting();
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("cron per-agent ownership", () => {
  it("requires a non-empty owner agent", () => {
    expect(() => cronAdd("", "0 * * * *", "echo hi", "noop")).toThrow(/non-empty agent/);
    // @ts-expect-error — exercising the runtime guard with a bad type
    expect(() => cronAdd(undefined, "0 * * * *", "echo hi", "noop")).toThrow();
  });

  it("persists the owning agent on each job", () => {
    const job = cronAdd("alpha", "0 * * * *", "do alpha thing", "alpha job", "agent");
    expect(job.agent).toBe("alpha");
    expect(cronList().find((j) => j.id === job.id)?.agent).toBe("alpha");
  });

  it("cronListForAgent returns ONLY that agent's jobs", () => {
    cronAdd("alpha", "0 * * * *", "a1", "alpha-1");
    cronAdd("alpha", "0 1 * * *", "a2", "alpha-2");
    cronAdd("beta", "0 2 * * *", "b1", "beta-1");

    const alpha = cronListForAgent("alpha");
    const beta = cronListForAgent("beta");
    expect(alpha).toHaveLength(2);
    expect(beta).toHaveLength(1);
    expect(alpha.every((j) => j.agent === "alpha")).toBe(true);
    expect(beta[0].agent).toBe("beta");
    // The full registry still holds all three (cron-job fan-out is prevented
    // at fire-time + tool scope, not by hiding rows from the registry).
    expect(cronList()).toHaveLength(3);
  });

  it("rejects an invalid cron schedule", () => {
    expect(() => cronAdd("alpha", "not-a-cron", "x", "bad")).toThrow(/Invalid cron schedule/);
  });
});
