/**
 * runtime.ts — the anthropic-compat runtime (04 §3).
 *
 * A hand-rolled agent loop on the Anthropic client SDK with a configurable
 * baseURL: one thin runtime covers every provider that speaks the Anthropic
 * Messages format — DeepSeek direct (verified, doc 03 §4), Ollama Cloud
 * (verified 2026-06-10, scripts/compat-smoke.mjs: hosts deepseek-v4-flash/
 * -pro, kimi-k2.6), and Anthropic itself via API key.
 *
 * We own the loop, so we own: tool harness (src/runtimes/shared/), safety
 * gating, transcript persistence + image surgery, per-provider quirk
 * normalization, client-side context budget (200k default), cache_control
 * placement, and per-turn telemetry (parity with the SDK lane).
 *
 * Requires a model-catalog assignment (config.modelInfo) for baseURL/key/
 * quirks; without one it targets the Anthropic API directly via
 * ANTHROPIC_API_KEY.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "crypto";
import type { QueryUsage, RunAgentResult, TurnSummary } from "../../core/agent.js";
import type { AgentRuntime, RuntimeRunOptions } from "../types.js";
import {
  buildSystemPromptDetailed,
  buildSafetyRules,
  buildToolGuidance,
} from "../../core/prompt-builder.js";
import { evictedBehaviorFiles } from "../../core/state-header.js";
import { appendTurnUsage, computeCacheRatio } from "../../core/telemetry.js";
import { createSharedTools, toAnthropicTools, type SharedTool } from "../shared/tool-registry.js";
import { checkBeforeTool, annotateAfterTool } from "../shared/safety.js";
import { getQuirks, normalizeMessages, normalizeImages, type Msg, type MsgBlock } from "./normalizer.js";
import { loadTranscript, saveTranscript, stripImages, newSessionId } from "./transcript-store.js";
import { enforceBudget, estimateTokens } from "./context-budget.js";
import { applyCacheControl } from "./cache-control.js";

const MAX_TURNS = 40;
const MAX_OUTPUT_TOKENS = 8192; // generous: thinking-block models burn output budget
const DEFAULT_CONTEXT_BUDGET = 200_000; // 04 §0: 200k everyone, 300k eng via catalog
const REQUEST_TIMEOUT_MS = 300_000;

// One fixed tool list per process — tool defs hash first in the cache prefix.
const SHARED_TOOLS: SharedTool[] = createSharedTools();
const TOOL_DEFS = toAnthropicTools(SHARED_TOOLS);
const TOOL_MAP = new Map(SHARED_TOOLS.map((t) => [t.name, t]));

async function run(opts: RuntimeRunOptions): Promise<RunAgentResult> {
  const { prompt, config, onMessage, sessionId, images } = opts;
  const info = config.modelInfo;
  const quirks = getQuirks(info?.quirks);

  const apiKeyEnv = info?.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    const msg = `anthropic-compat: ${apiKeyEnv} is not set in the environment — agent "${config.name}" cannot run.`;
    console.error(`[compat] ${msg}`);
    onMessage({ type: "error", content: `⚠️ ${msg}` });
    return { compacted: false };
  }

  const client = new Anthropic({
    apiKey, // x-api-key header (Anthropic, DeepSeek direct)
    authToken: apiKey, // Authorization: Bearer (Ollama Cloud requires this)
    baseURL: info?.baseURL, // undefined → api.anthropic.com
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2,
  });

  const queryId = "q-" + randomBytes(4).toString("hex");
  const startMs = Date.now();
  const { text: systemPrompt, meta: promptMeta } = buildSystemPromptDetailed({
    agentName: config.name,
    behaviorDir: config.behaviorDir,
    safetyRules: buildSafetyRules(config.safety),
    toolGuidance: buildToolGuidance(),
    evictFiles: evictedBehaviorFiles(config.stateHeader),
  });
  console.log(
    `[compat] ${config.name} → ${info?.modelId ?? config.model} via ${info?.baseURL ?? "api.anthropic.com"} ` +
      `(quirks: ${quirks.name}) | prompt ${systemPrompt.length} chars, hash ${promptMeta.hash}`
  );

  // ── Session ────────────────────────────────────────────────
  let currentSessionId = sessionId;
  let transcript: Msg[] | null = null;
  if (currentSessionId) {
    transcript = loadTranscript(config.behaviorDir, currentSessionId);
    if (!transcript) {
      console.error(`[compat] Session resume failed (${currentSessionId}), starting fresh`);
      onMessage({ type: "system", content: "⚠️ Session resume failed — starting fresh session." });
      currentSessionId = undefined;
    }
  }
  if (!currentSessionId) {
    currentSessionId = newSessionId();
    transcript = [];
  }
  const messages: Msg[] = transcript!;

  // ── New user turn (state header already prepended by runAgent) ──
  const userBlocks: MsgBlock[] = [];
  for (const img of images ?? []) {
    userBlocks.push({ type: "image", source: { type: "url", url: img.url } });
  }
  if (prompt.trim() || userBlocks.length === 0) {
    userBlocks.push({ type: "text", text: prompt.trim() ? prompt : " " });
  }
  messages.push({ role: "user", content: normalizeImages(userBlocks, quirks) });

  // ── Loop ───────────────────────────────────────────────────
  let turnIndex = 0;
  const turns: TurnSummary[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let lastTurnInputTokens = 0;
  let compacted = false;
  let prunedToolResults = 0;
  let droppedMessages = 0;
  let firstApiMs: number | null = null;
  let lastApiMs: number | null = null;

  const budget = info?.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  const model = info?.modelId ?? config.model;

  try {
    for (let i = 0; i < MAX_TURNS; i++) {
      // Budget → normalize → breakpoints, fresh each call.
      const budgeted = enforceBudget(messages, budget);
      if (budgeted.prunedToolResults > 0 || budgeted.droppedMessages > 0) {
        compacted = true;
        // enforceBudget is pure and recomputes over the FULL transcript each
        // call, so the latest round's counts ARE the total extent of editing
        // (monotonic — the transcript only grows). Overwrite, never sum.
        prunedToolResults = budgeted.prunedToolResults;
        droppedMessages = budgeted.droppedMessages;
        console.log(
          `[compat] context budget: pruned ${budgeted.prunedToolResults} tool results, dropped ${budgeted.droppedMessages} messages (est ${estimateTokens(budgeted.messages)} tokens)`
        );
      }
      const normalized = normalizeMessages(budgeted.messages, quirks);
      const req = applyCacheControl(systemPrompt, TOOL_DEFS, normalized, quirks.supportsCacheControl);

      const resp = (await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: req.system as any,
        tools: req.tools as any,
        messages: req.messages as any,
      })) as any;

      const now = Date.now();
      if (firstApiMs === null) firstApiMs = now;
      lastApiMs = now;

      // ── Per-turn telemetry (parity with the SDK lane) ──
      const u = resp.usage ?? {};
      const tIn = Number(u.input_tokens ?? 0);
      const tRead = Number(u.cache_read_input_tokens ?? 0);
      const tCreate = Number(u.cache_creation_input_tokens ?? 0);
      const tOut = Number(u.output_tokens ?? 0);
      inputTokens += tIn;
      cacheRead += tRead;
      cacheCreate += tCreate;
      outputTokens += tOut;
      lastTurnInputTokens = tIn + tRead + tCreate;
      turnIndex++;
      turns.push({ turn: turnIndex, input: tIn, cacheRead: tRead, cacheCreate: tCreate });
      appendTurnUsage({
        ts: new Date().toISOString(),
        agent: config.name,
        queryId,
        sessionId: currentSessionId,
        turn: turnIndex,
        input: tIn,
        cacheRead: tRead,
        cacheCreate: tCreate,
        ratio: computeCacheRatio(tRead, tCreate),
      });
      console.log(`[compat] turn ${turnIndex}: ${tIn} new + ${tRead} cached + ${tCreate} cache-create, ${tOut} out, stop=${resp.stop_reason}`);

      const content: MsgBlock[] = Array.isArray(resp.content) ? resp.content : [];
      // Persist the assistant turn (thinking stripped per quirks — replaying
      // reasoning wastes tokens and provider support for it varies).
      const persisted = content.filter(
        (b) => !(quirks.stripThinking && (b.type === "thinking" || b.type === "redacted_thinking"))
      );
      messages.push({ role: "assistant", content: persisted });

      const textBlocks = content.filter((b) => b.type === "text" && b.text && String(b.text).trim());
      const toolUses = content.filter((b) => b.type === "tool_use");

      if (resp.stop_reason === "tool_use" && toolUses.length > 0) {
        // Narration before work → interim subtext (same UX as the SDK lane).
        for (const t of textBlocks) onMessage({ type: "text_interim", content: String(t.text) });

        const results: MsgBlock[] = [];
        for (const tu of toolUses) {
          const text = await executeTool(tu, config);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: text.text,
            ...(text.isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      // Final turn: last text block is the reply, earlier ones are narration.
      for (let t = 0; t < textBlocks.length; t++) {
        const kind = t === textBlocks.length - 1 ? "text" : "text_interim";
        onMessage({ type: kind, content: String(textBlocks[t].text) });
      }
      if (textBlocks.length === 0) {
        // Thinking-only response (output budget consumed) — surface something.
        onMessage({ type: "text", content: "(no text response — the model spent its output budget on reasoning; try again)" });
      }
      break;
    }
    if (turnIndex >= MAX_TURNS) {
      onMessage({ type: "system", content: `⚠️ Stopped after ${MAX_TURNS} tool turns.` });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[compat] Agent error:`, errMsg);
    onMessage({ type: "error", content: `Agent error: ${errMsg}` });
  } finally {
    saveTranscript(config.behaviorDir, currentSessionId, stripImages(messages));
  }

  const durationMs = Date.now() - startMs;
  const usage: QueryUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    costUSD: 0, // catalog pricing computed by the runAgent facade (04 §5)
    numTurns: turnIndex,
    durationMs,
    durationApiMs: firstApiMs && lastApiMs ? lastApiMs - firstApiMs : 0,
    contextWindow: info?.contextWindow ?? DEFAULT_CONTEXT_BUDGET,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    lastTurnInputTokens,
  };

  return {
    sessionId: currentSessionId,
    usage,
    compacted,
    ...(compacted
      ? { contextEdits: { compactions: 0, prunedToolResults, droppedMessages } }
      : {}),
    promptMeta: { ...promptMeta, queryId },
    turns,
  };
}

async function executeTool(
  tu: MsgBlock,
  config: RuntimeRunOptions["config"]
): Promise<{ text: string; isError?: boolean }> {
  const name = String(tu.name ?? "");
  const args = (tu.input ?? {}) as Record<string, any>;
  const tool = TOOL_MAP.get(name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };

  const verdict = checkBeforeTool(name, args, config.safety);
  if (!verdict.allowed) {
    console.log(`[compat-safety] blocked ${name}: ${verdict.reason}`);
    return { text: verdict.reason, isError: true };
  }

  try {
    const result = await tool.execute(args, {
      workingDir: config.workingDir,
      behaviorDir: config.behaviorDir,
      agentName: config.name,
    });
    return { text: annotateAfterTool(name, result.text), isError: result.isError };
  } catch (e) {
    return { text: `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

export const anthropicCompatRuntime: AgentRuntime = {
  name: "anthropic-compat",
  run,
};
