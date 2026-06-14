/**
 * anthropic-compat building blocks (WP3): normalizer quirk shapes, context
 * budget eviction, cache breakpoints, transcript round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  getQuirks,
  normalizeMessages,
  normalizeImages,
  type Msg,
} from "../src/runtimes/anthropic-compat/normalizer.js";
import { enforceBudget, estimateTokens } from "../src/runtimes/anthropic-compat/context-budget.js";
import { applyCacheControl } from "../src/runtimes/anthropic-compat/cache-control.js";
import {
  loadTranscript,
  saveTranscript,
  stripImages,
  newSessionId,
} from "../src/runtimes/anthropic-compat/transcript-store.js";

const deepseek = getQuirks("deepseek");
const anthropic = getQuirks(undefined);

describe("normalizer", () => {
  it("strips thinking blocks and empty text on deepseek profile", () => {
    const msgs: Msg[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "   " },
          { type: "text", text: "real answer" },
        ],
      },
    ];
    const out = normalizeMessages(msgs, deepseek);
    expect(out[1].content).toEqual([{ type: "text", text: "real answer" }]);
    // anthropic profile keeps thinking
    const kept = normalizeMessages(msgs, anthropic);
    expect((kept[1].content as any[]).some((b) => b.type === "thinking")).toBe(true);
  });

  it("guarantees non-empty assistant content (the historical 400 shape)", () => {
    const msgs: Msg[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "thinking", thinking: "only thoughts" }] },
    ];
    const out = normalizeMessages(msgs, deepseek);
    expect(out[1].content).toEqual([{ type: "text", text: "(continuing)" }]);
  });

  it("coerces string-encoded tool_use input to an object (compact-JSON 400 shape)", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: '{"command":"ls"}' }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
    ];
    const out = normalizeMessages(msgs, deepseek);
    expect((out[0].content as any[])[0].input).toEqual({ command: "ls" });
    expect((out[1].content as any[])[0].content).toBe(""); // missing content materialized
  });

  it("never mutates its input", () => {
    const msgs: Msg[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: "{}" }] },
    ];
    normalizeMessages(msgs, deepseek);
    expect((msgs[0].content as any[])[0].input).toBe("{}");
  });

  it("replaces images with placeholders on non-vision lanes", () => {
    const blocks = [{ type: "image", source: { type: "url", url: "https://x/y.png" } }];
    expect(normalizeImages(blocks, deepseek)[0].type).toBe("text");
    expect(normalizeImages(blocks, anthropic)[0].type).toBe("image");
  });
});

describe("context budget", () => {
  function bigToolFlow(n: number): Msg[] {
    const msgs: Msg[] = [{ role: "user", content: "start" }];
    for (let i = 0; i < n; i++) {
      msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: {} }] });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(4000) }],
      });
    }
    msgs.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    msgs.push({ role: "user", content: "next question" });
    return msgs;
  }

  it("passes through under budget", () => {
    const msgs = bigToolFlow(2);
    const r = enforceBudget(msgs, 1_000_000);
    expect(r.messages).toBe(msgs);
    expect(r.prunedToolResults).toBe(0);
  });

  it("prunes old tool results first, keeping the working set", () => {
    const msgs = bigToolFlow(10);
    const before = estimateTokens(msgs);
    const r = enforceBudget(msgs, Math.floor(before * 0.6));
    expect(r.prunedToolResults).toBeGreaterThan(0);
    expect(estimateTokens(r.messages)).toBeLessThan(before);
    // most recent tool_result untouched (inside KEEP_RECENT window)
    const last = r.messages[r.messages.length - 3];
    expect(JSON.stringify(last)).toContain("xxxx");
  });

  it("drops oldest exchanges at clean-user boundaries when pruning isn't enough", () => {
    const msgs = bigToolFlow(10);
    const r = enforceBudget(msgs, 500); // brutally small
    expect(r.droppedMessages).toBeGreaterThan(0);
    // never orphan a tool_result: first message must not start with one
    const first = r.messages[0];
    const firstBlocks = typeof first.content === "string" ? [] : first.content;
    expect(firstBlocks.some((b: any) => b.type === "tool_result")).toBe(false);
  });
});

describe("cache control", () => {
  const tools = [
    { name: "A", description: "a", input_schema: {} },
    { name: "B", description: "b", input_schema: {} },
  ];
  const msgs: Msg[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    { role: "user", content: "q2" },
  ];

  it("disabled → untouched shapes (no cache_control anywhere)", () => {
    const r = applyCacheControl("sys", tools, msgs, false);
    expect(JSON.stringify(r)).not.toContain("cache_control");
    expect(r.system).toBe("sys");
  });

  it("enabled → breakpoints on system, last tool, second-to-last user msg", () => {
    const r = applyCacheControl("sys", tools, msgs, true);
    expect((r.system as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect((r.tools[0] as any).cache_control).toBeUndefined();
    expect((r.tools[1] as any).cache_control).toEqual({ type: "ephemeral" });
    const q1 = r.messages[0];
    expect((q1.content as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(r.messages[2])).not.toContain("cache_control"); // latest msg uncached
  });

  it("single user message → no conversation breakpoint", () => {
    const r = applyCacheControl("sys", tools, [{ role: "user", content: "only" }], true);
    expect(JSON.stringify(r.messages)).not.toContain("cache_control");
  });
});

describe("transcript store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hive-compat-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips messages and returns null for unknown sessions", () => {
    const id = newSessionId();
    expect(id).toMatch(/^compat-[0-9a-f]{12}$/);
    expect(loadTranscript(dir, id)).toBeNull();
    const msgs: Msg[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    saveTranscript(dir, id, msgs);
    expect(loadTranscript(dir, id)).toEqual(msgs);
  });

  it("stripImages replaces image blocks post-turn", () => {
    const msgs: Msg[] = [
      { role: "user", content: [{ type: "image", source: { type: "url", url: "u" } }, { type: "text", text: "t" }] },
    ];
    const out = stripImages(msgs);
    expect((out[0].content as any[])[0]).toEqual({ type: "text", text: "[image processed - data stripped post-turn]" });
    expect((msgs[0].content as any[])[0].type).toBe("image"); // input not mutated
  });
});
