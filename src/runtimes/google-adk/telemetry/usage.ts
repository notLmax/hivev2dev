/**
 * usage.ts
 *
 * Per-turn token telemetry for the Google ADK runtime.
 *
 * Gemini's GenerateContentResponse exposes `usageMetadata` with prompt /
 * candidates / cached / total token counts. ADK threads this through every
 * `LlmResponse` (and Event extends LlmResponse). We accumulate per turn,
 * then compute USD cost from a pricing table.
 *
 * Prices below are for Gemini 3.5 Flash (US regions, May 2026). Update when
 * Google changes pricing — there is no programmatic pricing endpoint.
 */

import type { QueryUsage } from "../../../core/agent.js";

interface GeminiPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

// US regions, on-demand, May 2026. Source: https://ai.google.dev/pricing
const PRICING: Record<string, GeminiPricing> = {
  "gemini-3.5-flash": {
    inputPerMillion: 1.5,
    cachedInputPerMillion: 0.15,
    outputPerMillion: 9.0,
  },
  "gemini-flash-latest": {
    inputPerMillion: 1.5,
    cachedInputPerMillion: 0.15,
    outputPerMillion: 9.0,
  },
  // Fallback row — used when the model name doesn't match. Conservative side
  // of "Flash". Switch to Pro pricing if the agent runs on Pro.
  default: {
    inputPerMillion: 1.5,
    cachedInputPerMillion: 0.15,
    outputPerMillion: 9.0,
  },
};

function priceFor(model: string): GeminiPricing {
  return PRICING[model] ?? PRICING.default;
}

export class UsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;
  private turns = 0;
  private startMs: number;
  private firstApiMs: number | null = null;
  private lastApiMs: number | null = null;
  private lastTurnInputTokens = 0;

  constructor(private model: string) {
    this.startMs = Date.now();
  }

  /**
   * Feed every Event's `usageMetadata`. Gemini emits usage on assistant
   * events; user/tool events have none.
   */
  recordEvent(usageMetadata: unknown): void {
    if (!usageMetadata || typeof usageMetadata !== "object") return;
    const um = usageMetadata as Record<string, unknown>;
    const prompt = Number(um.promptTokenCount ?? 0);
    const candidates = Number(um.candidatesTokenCount ?? 0);
    const cached = Number(um.cachedContentTokenCount ?? 0);
    if (!prompt && !candidates) return;

    this.inputTokens += prompt;
    this.outputTokens += candidates;
    this.cachedTokens += cached;
    this.lastTurnInputTokens = prompt;
    this.turns += 1;

    const now = Date.now();
    if (this.firstApiMs === null) this.firstApiMs = now;
    this.lastApiMs = now;
  }

  finalize(): QueryUsage {
    const pricing = priceFor(this.model);
    const freshInput = Math.max(0, this.inputTokens - this.cachedTokens);
    const costUSD =
      (freshInput * pricing.inputPerMillion +
        this.cachedTokens * pricing.cachedInputPerMillion +
        this.outputTokens * pricing.outputPerMillion) /
      1_000_000;

    const durationMs = Date.now() - this.startMs;
    const durationApiMs =
      this.firstApiMs && this.lastApiMs
        ? this.lastApiMs - this.firstApiMs
        : 0;

    return {
      // Canonical semantics across all runtimes (04 §5): inputTokens =
      // UNCACHED input only, matching the Anthropic convention the SDK lane
      // reports. Gemini's promptTokenCount includes cached tokens, so
      // subtract. (Pre-v2 this reported the cached-inclusive number — the
      // billing layer would have double-counted.)
      inputTokens: freshInput,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cachedTokens,
      // Gemini doesn't separate cache-create from cache-read — it does
      // implicit caching automatically. Bucket everything into cacheRead.
      cacheCreationTokens: 0,
      costUSD,
      numTurns: this.turns,
      durationMs,
      durationApiMs,
      contextWindow: 1_000_000, // Gemini 3.5 Flash
      maxOutputTokens: 8_192,
      lastTurnInputTokens: this.lastTurnInputTokens,
    };
  }
}
