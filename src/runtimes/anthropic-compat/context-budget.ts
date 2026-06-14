/**
 * context-budget.ts — client-side context enforcement for loop-owning
 * runtimes (04 §0: 200k everyone / 300k eng; 04 §3 implementation note).
 *
 * Two phases, mirroring the server-side context-editing design (doc 03 §3):
 *   1. prune oldest tool_result bodies to placeholders (cheap, keeps
 *      structure and tool_use/tool_result pairing intact)
 *   2. drop oldest whole exchanges, cutting only at "clean user" boundaries
 *      (a user message with no tool_result blocks) so no orphaned
 *      tool_result ever references a dropped tool_use — that 400s.
 *
 * Token estimate: chars/4 — coarse but only used as a trigger; the budget is
 * a guardrail, not an invoice.
 */

import type { Msg } from "./normalizer.js";

const PRUNED = "[pruned - over context budget; re-run the tool if needed]";
/** Never prune inside the most recent N messages — the model's working set. */
const KEEP_RECENT = 6;

export function estimateTokens(messages: Msg[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function isCleanUser(m: Msg): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return !m.content.some((b) => b.type === "tool_result");
}

export interface BudgetResult {
  messages: Msg[];
  prunedToolResults: number;
  droppedMessages: number;
}

export function enforceBudget(messages: Msg[], budgetTokens: number): BudgetResult {
  let msgs = messages;
  let prunedToolResults = 0;
  let droppedMessages = 0;

  if (estimateTokens(msgs) <= budgetTokens) {
    return { messages: msgs, prunedToolResults, droppedMessages };
  }

  // Phase 1 — prune old tool_result bodies (oldest first, skip the working set).
  msgs = msgs.map((m) => ({ ...m, content: typeof m.content === "string" ? m.content : [...m.content] }));
  for (let i = 0; i < msgs.length - KEEP_RECENT; i++) {
    if (estimateTokens(msgs) <= budgetTokens) break;
    const m = msgs[i];
    if (typeof m.content === "string") continue;
    m.content = m.content.map((b) => {
      if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > PRUNED.length) {
        prunedToolResults++;
        return { ...b, content: PRUNED };
      }
      return b;
    });
  }

  // Phase 2 — drop oldest exchanges. Prefer clean-user boundaries; in a pure
  // tool storm (no clean user outside the working set) cut at ANY user
  // message and replace its orphaned tool_results with a text placeholder —
  // alternation stays valid (transcript still starts with user) and no
  // tool_result references a dropped tool_use.
  while (estimateTokens(msgs) > budgetTokens) {
    let cut = -1;
    for (let i = 1; i < msgs.length - KEEP_RECENT; i++) {
      if (isCleanUser(msgs[i])) {
        cut = i;
        break;
      }
    }
    let needsPlaceholder = false;
    if (cut <= 0) {
      for (let i = 1; i < msgs.length - KEEP_RECENT; i++) {
        if (msgs[i].role === "user") {
          cut = i;
          needsPlaceholder = true;
          break;
        }
      }
    }
    if (cut <= 0) break; // nothing safely droppable
    droppedMessages += cut;
    msgs = msgs.slice(cut);
    if (needsPlaceholder) {
      msgs[0] = { role: "user", content: [{ type: "text", text: "[earlier tool exchanges pruned - over context budget]" }] };
    }
  }

  return { messages: msgs, prunedToolResults, droppedMessages };
}
