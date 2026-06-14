/**
 * spend-caps.ts — per-agent daily/monthly USD caps (04 §5).
 *
 * Caps were deliberately omitted in v1; v2 requires them: after June 15, overage either
 * burns usage credits or hard-stops a seat mid-task. Semantics:
 *
 *   no caps configured → always ok (the default for every current agent —
 *                        caps arrive only via a models.yaml assignment)
 *   ≥ 80% of a cap     → warn once per local day per level
 *   ≥ 100% of a cap    → stop (the runAgent facade refuses to dispatch)
 *
 * Enforcement point is the runAgent() facade — the single chokepoint that
 * covers Discord, hivemind, codex-wake, and cron entry paths at once.
 */

import type { SpendCaps } from "../core/model-catalog.js";
import { getSpend, markWarned, localDate } from "./spend-rollup.js";

export type CapDecision =
  | { state: "ok" }
  | { state: "warn" | "stop"; message: string };

const WARN_FRACTION = 0.8;

export function checkSpendCaps(
  agent: string,
  caps?: SpendCaps,
  dataDir?: string,
  now: Date = new Date()
): CapDecision {
  if (!caps || (caps.dailyUSD === undefined && caps.monthlyUSD === undefined)) {
    return { state: "ok" };
  }

  const spend = getSpend(agent, dataDir, now);
  const levels: Array<{ level: "daily" | "monthly"; spent: number; cap?: number; window: string }> = [
    { level: "daily", spent: spend.daily.usd, cap: caps.dailyUSD, window: `today (${spend.daily.date})` },
    { level: "monthly", spent: spend.monthly.usd, cap: caps.monthlyUSD, window: spend.monthly.month },
  ];

  for (const { level, spent, cap, window } of levels) {
    if (cap === undefined || cap <= 0) continue;
    if (spent >= cap) {
      return {
        state: "stop",
        message:
          `Spend cap reached: $${spent.toFixed(2)} / $${cap.toFixed(2)} ${level} (${window}) — ` +
          `agent halted. Raise the cap in config/models.yaml or wait for the window to reset.`,
      };
    }
  }

  for (const { level, spent, cap, window } of levels) {
    if (cap === undefined || cap <= 0) continue;
    if (spent >= cap * WARN_FRACTION && spend.warnedAt?.[level] !== localDate(now)) {
      markWarned(agent, level, dataDir, now);
      return {
        state: "warn",
        message:
          `Spend at ${Math.round((spent / cap) * 100)}% of ${level} cap: ` +
          `$${spent.toFixed(2)} / $${cap.toFixed(2)} (${window}).`,
      };
    }
  }

  return { state: "ok" };
}
