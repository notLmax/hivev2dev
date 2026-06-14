/**
 * claude-sdk-runtime.ts — the default runtime: Anthropic Agent SDK.
 *
 * Extracted VERBATIM from the inline SDK path in src/core/agent.ts (04 §3,
 * zero behavior change). Consumes the per-seat plan SDK credit; the SDK
 * applies prompt caching automatically — prefix stability is guaranteed by
 * the prompt-builder freeze contract and the Session State header (prepended
 * by runAgent() before dispatch, so `opts.prompt` already carries it).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  buildSystemPromptDetailed,
  buildSafetyRules,
  buildToolGuidance,
} from "../core/prompt-builder.js";
import { appendTurnUsage, computeCacheRatio } from "../core/telemetry.js";
import { evictedBehaviorFiles } from "../core/state-header.js";
import { createHiveToolsServer } from "../tools/hive-tools-server.js";
import { createSafetyHooks } from "../safety/safety-hooks.js";
import { getSpend } from "../billing/spend-rollup.js";
import { randomBytes } from "crypto";
import { join } from "path";
import type { QueryUsage, RunAgentResult, TurnSummary } from "../core/agent.js";
import type { AgentRuntime, RuntimeRunOptions } from "./types.js";

/**
 * CACHE INVARIANT (Queen Bee 04 §4.3): tool definitions hash FIRST in the
 * Anthropic prefix (tools → system → messages) — any variance invalidates the
 * entire cache behind it. This list is a frozen module constant: never vary it
 * per-turn, per-session, or conditionally. Additions are rare, deliberate,
 * fleet-wide prefix busts.
 */
const ALLOWED_TOOLS = Object.freeze([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
] as const);

async function run(opts: RuntimeRunOptions): Promise<RunAgentResult> {
  const { prompt, config, onMessage, sessionId, images } = opts;

  let returnSessionId: string | undefined;
  let queryUsage: QueryUsage | undefined;
  let compacted = false;
  let compactions = 0;
  let compactionPreTokens: number | undefined;
  let lastTurnInputTokens = 0; // Track per-turn usage from assistant messages
  // Queen Bee telemetry (04 §4.0): correlate per-turn cache records to this query.
  const queryId = "q-" + randomBytes(4).toString("hex");
  let turnIndex = 0;
  const turns: TurnSummary[] = [];
  // Buffer for the most recent assistant text block. We only know it was
  // "interim narration" (not the final reply) once a subsequent tool_use or
  // text block arrives. If it's still buffered when `result` fires, it IS the
  // final — let the result event emit it as a proper `text` message instead.
  let pendingText: string | null = null;

  const { text: systemPrompt, meta: promptMeta } = buildSystemPromptDetailed({
    agentName: config.name,
    behaviorDir: config.behaviorDir,
    safetyRules: buildSafetyRules(config.safety),
    toolGuidance: buildToolGuidance(),
    // Same flags drive eviction here and inclusion in the state header
    // (prepended by runAgent) — the two can never disagree (04 §4.2).
    evictFiles: evictedBehaviorFiles(config.stateHeader),
  });

  console.log(
    `[prompt] System prompt: ${systemPrompt.length} chars, ~${Math.round(systemPrompt.length / 4)} tokens (est), hash ${promptMeta.hash}`
  );

  // Build MCP servers config.
  //
  // CACHE INVARIANT (Queen Bee 04 §4.3): MCP tool schemas are part of the
  // prefix that hashes FIRST. Composition must be static for the lifetime of
  // the process: hive-tools always; codex iff config.codex.enabled (global,
  // read once at startup); playwright iff agent's browser.enabled (per-agent
  // constant). sdkOptions is rebuilt per query but only from process-static
  // inputs — the only per-query field is `resume`, which is not in the prefix.
  // RULES: (1) any new MCP server must be gated on process-lifetime-static
  // config, never per-turn state; (2) hive-tools schemas must stay identical
  // across agents — per-agent schema variance fragments the cache fleet-wide;
  // (3) flipping codex.enabled busts every agent's tool prefix on restart
  // (acceptable, rare — but know it when reading cache-report).
  const mcpServers: Record<string, unknown> = {};
  if (config.codex.enabled) {
    mcpServers["codex"] = {
      command: config.codex.command,
      args: config.codex.args,
    };
  }

  // Add in-process Hive tools (cron, memory, patch, process, messaging)
  mcpServers["hive-tools"] = createHiveToolsServer(config.behaviorDir, config.name);

  // Per-agent browser capability via Playwright MCP (visual page review, click,
  // fill, screenshot). Persistent profile dir per-agent so logged-in sessions
  // survive across turns. Gated on config.browser.enabled.
  if (config.browser.enabled) {
    const playwrightProfile = join(process.cwd(), "data", "playwright-profiles", config.name);
    mcpServers["playwright"] = {
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        "--user-data-dir", playwrightProfile,
        "--headless",
        "--browser", "chromium",
        "--viewport-size", "1440x900",
      ],
    };
  }

  // Safety hooks — block dangerous commands and enforce path restrictions
  const safetyHooks = createSafetyHooks(config.safety);

  // SDK options
  const sdkOptions: Record<string, unknown> = {
    systemPrompt,
    model: config.model,
    cwd: config.workingDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: [...ALLOWED_TOOLS],
    hooks: safetyHooks,
    thinkingConfig: { type: "adaptive" },
    // Tool-output hygiene (Queen Bee 04 §4.8) — parity with the ADK lane's
    // caps. Oversized tool results are silent context filler: they persist in
    // the session and are re-billed (at minimum cache-read rate) on EVERY
    // subsequent turn, forever. Claude Code defaults: Bash 30,000 chars, MCP
    // results 25,000 tokens. We tighten to 16 KB / 10k tokens; an operator can
    // override either via the process environment.
    // (Agent SDK 0.2.0 exposes no tool-result CLEARING option — pruning of
    // old results in long sessions is handled by the SDK's auto-compaction,
    // which we already track via compact_boundary events.)
    env: {
      ...process.env,
      BASH_MAX_OUTPUT_LENGTH: process.env.BASH_MAX_OUTPUT_LENGTH ?? "16384",
      MAX_MCP_OUTPUT_TOKENS: process.env.MAX_MCP_OUTPUT_TOKENS ?? "10000",
    },
  };

  // Per-query USD backstop (04 §5): the facade's spend-cap check runs BEFORE
  // dispatch — it cannot stop a single runaway query mid-flight. When a daily
  // cap is configured, tell the SDK to abort the query if its own cost
  // estimate exceeds what's left of today's budget (floor $0.05 so a nearly
  // exhausted budget still allows a trivial turn; the facade hard-stops at
  // 100% on the next query either way).
  const dailyCap = config.modelInfo?.caps?.dailyUSD;
  if (dailyCap !== undefined && dailyCap > 0) {
    const spentToday = getSpend(config.name).daily.usd;
    sdkOptions.maxBudgetUsd = Math.max(0.05, dailyCap - spentToday);
  }

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  if (Object.keys(mcpServers).length > 0) {
    sdkOptions.mcpServers = mcpServers;
  }

  // Build the prompt — plain string or multimodal with image content blocks
  let queryPrompt: any = prompt;
  if (images && images.length > 0) {
    const contentBlocks: any[] = [];
    for (const img of images) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "url",
          url: img.url,
        },
      });
    }
    if (prompt.trim()) {
      contentBlocks.push({ type: "text", text: prompt });
    }
    const userMessage = {
      type: "user" as const,
      message: { role: "user" as const, content: contentBlocks },
      parent_tool_use_id: null,
    };
    // query() expects string | AsyncIterable<SDKUserMessage>, so wrap in an async generator
    console.log(`[images] Sending multimodal prompt with ${contentBlocks.length} content block(s)`);
    console.log(`[images] Block types: ${contentBlocks.map((b: any) => b.type).join(", ")}`);
    queryPrompt = (async function* () {
      console.log("[images] Async generator yielding SDKUserMessage");
      yield userMessage;
      console.log("[images] Async generator done");
    })();
  }

  // Process the SDK query stream. If resume is set and fails, retry fresh.
  const maxAttempts = sessionId ? 2 : 1;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const queryStream = query({ prompt: queryPrompt, options: sdkOptions } as any);
      for await (const message of queryStream) {
        if (typeof message !== "object" || message === null) continue;

        const msg = message as Record<string, unknown>;

        switch (msg.type) {
          case "system": {
            const subtype = msg.subtype as string;
            if (subtype === "init" && msg.session_id) {
              returnSessionId = msg.session_id as string;
            }
            // Track compaction events (persisted via RunAgentResult.contextEdits)
            if (subtype === "compact_boundary") {
              compacted = true;
              compactions++;
              const metadata = msg.compact_metadata as Record<string, unknown> | undefined;
              const preTokens = metadata?.pre_tokens as number | undefined;
              if (preTokens !== undefined) compactionPreTokens = preTokens;
              console.log(`[agent] Compaction occurred — pre_tokens: ${preTokens ?? "unknown"}`);
            }
            break;
          }

          case "assistant": {
            const assistantMsg = msg.message as Record<string, unknown> | undefined;
            if (!assistantMsg) break;

            // Capture per-turn usage — the last assistant message's tokens = actual context size
            // Total context = input_tokens (non-cached) + cache_read + cache_creation
            const turnUsage = assistantMsg.usage as Record<string, unknown> | undefined;
            if (turnUsage) {
              const turnInput = (turnUsage.input_tokens as number) || 0;
              const turnCacheRead = (turnUsage.cache_read_input_tokens as number) || 0;
              const turnCacheCreation = (turnUsage.cache_creation_input_tokens as number) || 0;
              lastTurnInputTokens = turnInput + turnCacheRead + turnCacheCreation;
              console.log(`[context] Per-turn: ${turnInput} new + ${turnCacheRead} cached + ${turnCacheCreation} cache-create = ${lastTurnInputTokens} total`);

              // Queen Bee KPI (04 §4.0): persist the per-turn read:create ratio.
              turnIndex++;
              turns.push({
                turn: turnIndex,
                input: turnInput,
                cacheRead: turnCacheRead,
                cacheCreate: turnCacheCreation,
              });
              appendTurnUsage({
                ts: new Date().toISOString(),
                agent: config.name,
                queryId,
                sessionId: returnSessionId ?? sessionId,
                turn: turnIndex,
                input: turnInput,
                cacheRead: turnCacheRead,
                cacheCreate: turnCacheCreation,
                ratio: computeCacheRatio(turnCacheRead, turnCacheCreation),
              });
            }

            const content = assistantMsg.content as Array<Record<string, unknown>> | undefined;
            if (!content || !Array.isArray(content)) break;

            // Buffer-and-flush strategy: a text block is only "interim
            // narration" if proven so by a subsequent tool_use or text block.
            // Text still in the buffer when `result` fires is the final reply.
            const hasToolUse = content.some((b) => b.type === "tool_use");
            if (hasToolUse && pendingText !== null) {
              // The buffered text came before work — it was narration. Flush as subtext.
              onMessage({ type: "text_interim", content: pendingText });
              pendingText = null;
            }

            for (const block of content) {
              if (block.type === "text" && block.text) {
                const text = block.text as string;
                // If we already had buffered text and now another text block
                // arrived, the previous one was narration — flush it.
                if (pendingText !== null) {
                  onMessage({ type: "text_interim", content: pendingText });
                }
                pendingText = text;
              }
            }
            break;
          }

          case "result": {
            // DEBUG: dump raw result message to see all available fields
            console.log(`[debug-result] Keys: ${Object.keys(msg).join(", ")}`);
            console.log(`[debug-result] usage keys: ${msg.usage ? Object.keys(msg.usage as object).join(", ") : "null"}`);
            console.log(`[debug-result] usage: ${JSON.stringify(msg.usage)}`);
            console.log(`[debug-result] modelUsage: ${JSON.stringify(msg.modelUsage)}`);
            console.log(`[debug-result] num_turns: ${msg.num_turns}`);

            // Extract text result. Prefer the SDK's result field; fall back
            // to the buffered pendingText if the SDK didn't populate it.
            const result = msg.result as string | undefined;
            const finalText = (result && result.trim()) ? result : pendingText;
            if (finalText && finalText.trim()) {
              onMessage({
                type: "text",
                content: finalText,
              });
            }
            pendingText = null;

            // Extract usage data
            const totalCost = msg.total_cost_usd as number | undefined;
            const numTurns = msg.num_turns as number | undefined;
            const durationMs = msg.duration_ms as number | undefined;
            const durationApiMs = msg.duration_api_ms as number | undefined;
            const usage = msg.usage as Record<string, unknown> | undefined;
            const modelUsageMap = msg.modelUsage as Record<string, Record<string, unknown>> | undefined;

            if (usage || modelUsageMap) {
              // Get per-model stats (first model entry)
              let contextWindow = 200_000; // default for Opus
              let maxOutputTokens = 16_384;
              if (modelUsageMap) {
                const firstModel = Object.values(modelUsageMap)[0];
                if (firstModel) {
                  contextWindow = (firstModel.contextWindow as number) || contextWindow;
                  maxOutputTokens = (firstModel.maxOutputTokens as number) || maxOutputTokens;
                }
              }

              queryUsage = {
                inputTokens: (usage?.input_tokens as number) || 0,
                outputTokens: (usage?.output_tokens as number) || 0,
                cacheReadTokens: (usage?.cache_read_input_tokens as number) || 0,
                cacheCreationTokens: (usage?.cache_creation_input_tokens as number) || 0,
                costUSD: totalCost || 0,
                numTurns: numTurns || 0,
                durationMs: durationMs || 0,
                durationApiMs: durationApiMs || 0,
                contextWindow,
                maxOutputTokens,
                lastTurnInputTokens,
              };

              // Log to console for PM2 visibility
              const cacheTotal = queryUsage.cacheReadTokens + queryUsage.cacheCreationTokens;
              const cacheHitPct = cacheTotal > 0
                ? Math.round((queryUsage.cacheReadTokens / cacheTotal) * 100)
                : 0;
              console.log(
                `[usage] ${queryUsage.inputTokens.toLocaleString()} in / ${queryUsage.outputTokens.toLocaleString()} out` +
                ` | cache: ${cacheHitPct}% hit (${queryUsage.cacheReadTokens.toLocaleString()} read, ${queryUsage.cacheCreationTokens.toLocaleString()} new)` +
                ` | $${queryUsage.costUSD.toFixed(4)} | ${queryUsage.numTurns} turns | ${(queryUsage.durationMs / 1000).toFixed(1)}s`
              );
            }
            break;
          }

          case "rate_limit_event": {
            const info = msg.rate_limit_info as Record<string, unknown> | undefined;
            if (info?.isUsingOverage) {
              onMessage({
                type: "system",
                content: "⚠️ Using overage billing — MAX quota may be exhausted.",
              });
            }
            break;
          }

          default:
            break;
        }
      }
      // ── Context usage diagnostic ─────────────────────────────
      try {
        const ctx = await (queryStream as any).getContextUsage();
        if (ctx) {
          console.log(`\n[context-diag] ═══ Context Usage Breakdown ═══`);
          console.log(`[context-diag] Total: ${ctx.totalTokens?.toLocaleString()} / ${ctx.maxTokens?.toLocaleString()} (${ctx.percentage}%)`);

          if (ctx.categories?.length) {
            console.log(`[context-diag] Categories:`);
            for (const cat of ctx.categories) {
              console.log(`[context-diag]   ${cat.name}: ${cat.tokens?.toLocaleString()}${cat.isDeferred ? ' (deferred)' : ''}`);
            }
          }

          if (ctx.systemPromptSections?.length) {
            console.log(`[context-diag] System Prompt Sections:`);
            for (const sec of ctx.systemPromptSections) {
              console.log(`[context-diag]   ${sec.name}: ${sec.tokens?.toLocaleString()}`);
            }
          }

          if (ctx.mcpTools?.length) {
            console.log(`[context-diag] MCP Tools: ${ctx.mcpTools.length} total`);
            const loaded = ctx.mcpTools.filter((t: any) => t.isLoaded);
            const deferred = ctx.mcpTools.filter((t: any) => !t.isLoaded);
            if (loaded.length) {
              const loadedTokens = loaded.reduce((sum: number, t: any) => sum + (t.tokens || 0), 0);
              console.log(`[context-diag]   Loaded: ${loaded.length} tools, ${loadedTokens.toLocaleString()} tokens`);
            }
            if (deferred.length) {
              const deferredTokens = deferred.reduce((sum: number, t: any) => sum + (t.tokens || 0), 0);
              console.log(`[context-diag]   Deferred: ${deferred.length} tools, ${deferredTokens.toLocaleString()} tokens`);
            }
          }

          if (ctx.deferredBuiltinTools?.length) {
            const totalDeferredTokens = ctx.deferredBuiltinTools.reduce((sum: number, t: any) => sum + (t.tokens || 0), 0);
            console.log(`[context-diag] Deferred Built-in Tools: ${ctx.deferredBuiltinTools.length}, ${totalDeferredTokens.toLocaleString()} tokens`);
          }

          if (ctx.skills) {
            console.log(`[context-diag] Skills: ${ctx.skills.includedSkills}/${ctx.skills.totalSkills}, ${ctx.skills.tokens?.toLocaleString()} tokens`);
          }

          if (ctx.messageBreakdown) {
            const mb = ctx.messageBreakdown;
            console.log(`[context-diag] Message Breakdown:`);
            console.log(`[context-diag]   User messages: ${mb.userMessageTokens?.toLocaleString()}`);
            console.log(`[context-diag]   Assistant messages: ${mb.assistantMessageTokens?.toLocaleString()}`);
            console.log(`[context-diag]   Tool calls: ${mb.toolCallTokens?.toLocaleString()}`);
            console.log(`[context-diag]   Tool results: ${mb.toolResultTokens?.toLocaleString()}`);
            if (mb.redirectedContextTokens) {
              console.log(`[context-diag]   Redirected context: ${mb.redirectedContextTokens?.toLocaleString()}`);
            }
          }

          if (ctx.apiUsage) {
            const au = ctx.apiUsage;
            console.log(`[context-diag] API Usage (last turn):`);
            console.log(`[context-diag]   input: ${au.input_tokens?.toLocaleString()}, cache_read: ${au.cache_read_input_tokens?.toLocaleString()}, cache_create: ${au.cache_creation_input_tokens?.toLocaleString()}`);
          }

          console.log(`[context-diag] ═══════════════════════════════\n`);
        }
      } catch (ctxErr) {
        console.log(`[context-diag] getContextUsage failed: ${ctxErr}`);
      }
      // ── End context diagnostic ──────────────────────────────

      break; // Success — exit retry loop
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      if (attempt < maxAttempts && sdkOptions.resume) {
        // Resume failed — clear resume and retry with a fresh session
        console.error(`[agent] Session resume failed, retrying fresh: ${errMsg}`);
        delete sdkOptions.resume;
        onMessage({
          type: "system",
          content: "⚠️ Session resume failed — starting fresh session.",
        });
        continue;
      }

      onMessage({ type: "error", content: `Agent error: ${errMsg}` });
    }
  }

  return {
    sessionId: returnSessionId,
    usage: queryUsage,
    compacted,
    ...(compactions > 0
      ? { contextEdits: { compactions, compactionPreTokens, prunedToolResults: 0, droppedMessages: 0 } }
      : {}),
    promptMeta: { ...promptMeta, queryId },
    turns,
  };
}

export const claudeSdkRuntime: AgentRuntime = {
  name: "claude-agent-sdk",
  run,
};
