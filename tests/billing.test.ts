/**
 * Billing tests (04 §5): pricing math, spend rollup rollover, cap thresholds
 * with once-per-day warn dedup. Fixtures in os.tmpdir().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { computeCostUSD } from "../src/billing/pricing.js";
import { addSpend, getSpend, localDate, localMonth } from "../src/billing/spend-rollup.js";
import { checkSpendCaps } from "../src/billing/spend-caps.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hive-billing-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("computeCostUSD", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheCreationTokens: 500_000 };

  it("prices all four buckets from explicit rates", () => {
    // sonnet-style: in 3, out 15, cachedIn 0.30, cacheWrite 3.75
    const cost = computeCostUSD(usage, { in: 3, out: 15, cachedIn: 0.3, cacheWrite: 3.75 });
    // 1M*3 + 2M*0.30 + 0.5M*3.75 + 0.1M*15 = 3 + 0.6 + 1.875 + 1.5
    expect(cost).toBeCloseTo(6.975, 6);
  });

  it("defaults: cachedIn = in, cacheWrite = 1.25 × in", () => {
    const cost = computeCostUSD(usage, { in: 1, out: 10 });
    // 1M*1 + 2M*1 + 0.5M*1.25 + 0.1M*10 = 1 + 2 + 0.625 + 1
    expect(cost).toBeCloseTo(4.625, 6);
  });

  it("deepseek-scale numbers stay sane", () => {
    const cost = computeCostUSD(
      { inputTokens: 0, outputTokens: 10_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 },
      { in: 0.14, out: 0.28, cachedIn: 0.0028 }
    );
    expect(cost).toBeCloseTo(0.0028 + 0.0028, 4); // 1M cached reads + 10k out
  });
});

describe("spend rollup", () => {
  const day1 = new Date(2026, 5, 10, 12, 0, 0); // 2026-06-10 local
  const day2 = new Date(2026, 5, 11, 9, 0, 0);
  const nextMonth = new Date(2026, 6, 1, 9, 0, 0);

  it("accumulates within a day and rolls over day/month boundaries", () => {
    addSpend("worker", 1.5, dataDir, day1);
    addSpend("worker", 0.5, dataDir, day1);
    let s = getSpend("worker", dataDir, day1);
    expect(s.daily.usd).toBeCloseTo(2.0);
    expect(s.daily.queries).toBe(2);
    expect(s.monthly.usd).toBeCloseTo(2.0);

    s = getSpend("worker", dataDir, day2); // next local day
    expect(s.daily.usd).toBe(0);
    expect(s.monthly.usd).toBeCloseTo(2.0); // month persists

    s = getSpend("worker", dataDir, nextMonth);
    expect(s.monthly.usd).toBe(0);
  });

  it("ignores garbage amounts, survives missing files", () => {
    addSpend("worker", NaN, dataDir, day1);
    addSpend("worker", -5, dataDir, day1);
    const s = getSpend("worker", dataDir, day1);
    expect(s.daily.usd).toBe(0);
    expect(s.daily.queries).toBe(2); // queries still counted
    expect(getSpend("never-seen", dataDir, day1).daily.usd).toBe(0);
  });

  it("localDate/localMonth format", () => {
    expect(localDate(day1)).toBe("2026-06-10");
    expect(localMonth(day1)).toBe("2026-06");
  });
});

describe("checkSpendCaps", () => {
  const now = new Date(2026, 5, 10, 12, 0, 0);

  it("no caps configured → always ok (the default for current agents)", () => {
    addSpend("worker", 999, dataDir, now);
    expect(checkSpendCaps("worker", undefined, dataDir, now)).toEqual({ state: "ok" });
    expect(checkSpendCaps("worker", {}, dataDir, now)).toEqual({ state: "ok" });
  });

  it("under 80% → ok; 80%+ → warn once per day; 100%+ → stop", () => {
    addSpend("worker", 7.0, dataDir, now);
    expect(checkSpendCaps("worker", { dailyUSD: 10 }, dataDir, now).state).toBe("ok");

    addSpend("worker", 1.5, dataDir, now); // 8.5 / 10 = 85%
    const warn = checkSpendCaps("worker", { dailyUSD: 10 }, dataDir, now);
    expect(warn.state).toBe("warn");
    expect((warn as { message: string }).message).toMatch(/85%/);

    // Deduped: second check the same day stays ok.
    expect(checkSpendCaps("worker", { dailyUSD: 10 }, dataDir, now).state).toBe("ok");

    addSpend("worker", 2.0, dataDir, now); // 10.5 ≥ 10
    const stop = checkSpendCaps("worker", { dailyUSD: 10 }, dataDir, now);
    expect(stop.state).toBe("stop");
    expect((stop as { message: string }).message).toMatch(/halted/);
  });

  it("monthly cap stops independently of daily", () => {
    addSpend("worker", 50, dataDir, now);
    const stop = checkSpendCaps("worker", { dailyUSD: 100, monthlyUSD: 40 }, dataDir, now);
    expect(stop.state).toBe("stop");
    expect((stop as { message: string }).message).toMatch(/monthly/);
  });

  it("warn resets next day (new local date)", () => {
    addSpend("worker", 8.5, dataDir, now);
    expect(checkSpendCaps("worker", { dailyUSD: 10 }, dataDir, now).state).toBe("warn");
    const tomorrow = new Date(2026, 5, 11, 12, 0, 0);
    addSpend("worker", 9.0, dataDir, tomorrow); // fresh day, 90%
    expect(checkSpendCaps("worker", { dailyUSD: 10 }, dataDir, tomorrow).state).toBe("warn");
  });
});
