/**
 * pricing.ts — provider-agnostic cost computation from catalog pricing (04 §5).
 *
 * CANONICAL USAGE SEMANTICS (all runtimes must conform):
 *   inputTokens         = UNCACHED input tokens only (Anthropic convention;
 *                         the ADK accumulator was fixed to match)
 *   cacheReadTokens     = tokens read from cache
 *   cacheCreationTokens = tokens written to cache (0 for implicit-caching
 *                         providers that don't report it)
 *
 * Client-reported costs (Agent SDK total_cost_usd, the ADK's hardcoded
 * table) are estimates — log them, but billing decisions use catalog-priced
 * computation, and neither is authoritative vs the provider console (04 §9).
 */

import type { ModelPrice } from "../core/model-catalog.js";

export interface BillableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * USD cost from catalog pricing. Defaults when the catalog omits cache rows:
 * cachedIn = full input rate (conservative), cacheWrite = 1.25× input
 * (Anthropic's 5-minute-TTL multiplier, doc 03 §2).
 */
export function computeCostUSD(u: BillableUsage, price: ModelPrice): number {
  const cachedIn = price.cachedIn ?? price.in;
  const cacheWrite = price.cacheWrite ?? price.in * 1.25;
  return (
    (u.inputTokens * price.in +
      u.cacheReadTokens * cachedIn +
      u.cacheCreationTokens * cacheWrite +
      u.outputTokens * price.out) /
    1_000_000
  );
}
