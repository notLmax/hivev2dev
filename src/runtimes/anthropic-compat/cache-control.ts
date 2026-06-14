/**
 * cache-control.ts — explicit cache breakpoints for client-SDK lanes
 * (doc 03 §2: up to 4 breakpoints; prefix order tools → system → messages).
 *
 * Placement: end of tools, end of system, and a moving breakpoint on the
 * last block of the SECOND-TO-LAST user message (the latest complete turn —
 * everything before the new message gets cached). Skipped entirely when the
 * provider doesn't support it (DeepSeek/Kimi cache implicitly; unknown
 * fields are a 400 risk).
 */

import type { AnthropicToolDef } from "../shared/tool-registry.js";
import type { Msg, MsgBlock } from "./normalizer.js";

const EPHEMERAL = { type: "ephemeral" as const };

export interface CacheControlledRequest {
  system: string | Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  messages: Msg[];
}

export function applyCacheControl(
  system: string,
  tools: AnthropicToolDef[],
  messages: Msg[],
  enabled: boolean
): CacheControlledRequest {
  if (!enabled) {
    return { system, tools: tools.map((t) => ({ ...t })), messages };
  }

  const sysBlocks = [{ type: "text", text: system, cache_control: EPHEMERAL }];

  const toolDefs: Array<Record<string, unknown>> = tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : { ...t }
  );

  // Moving conversation breakpoint: last block of the second-to-last user msg.
  const userIndexes = messages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  if (userIndexes.length < 2) {
    return { system: sysBlocks, tools: toolDefs, messages };
  }
  const target = userIndexes[userIndexes.length - 2];
  const out = messages.map((m, i) => {
    if (i !== target) return m;
    const blocks: MsgBlock[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map((b) => ({ ...b }));
    if (blocks.length > 0) {
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
    }
    return { ...m, content: blocks };
  });
  return { system: sysBlocks, tools: toolDefs, messages: out };
}
