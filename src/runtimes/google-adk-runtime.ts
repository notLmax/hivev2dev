/**
 * google-adk-runtime.ts
 *
 * Third runtime backend for the Hive — drives Gemini 3.5 Flash through the
 * Google Agent Development Kit. Implements the same `runAgent` contract as
 * the Anthropic SDK runtime (src/core/agent.ts) and the Claude CLI runtime
 * (src/runtimes/claude-cli-runtime.ts), so bot.ts is runtime-blind.
 *
 * Parity with the Anthropic SDK runtime:
 *  - System prompt: assembled via prompt-builder, passed as LlmAgent.instruction
 *  - Built-in tools: Bash, Read, Write, Edit, Glob, Grep (reimplemented as
 *      FunctionTool in tools/basic-tools.ts) + GOOGLE_SEARCH + URL_CONTEXT
 *      from ADK (replaces WebSearch + WebFetch)
 *  - MCP servers: hive-tools (always), codex (when enabled), playwright (when
 *      enabled). Attached via MCPToolset.
 *  - Safety hooks: beforeToolCallback + afterToolCallback (ADK native), wired
 *      to the existing safety primitives (command-filter, injection-guard).
 *  - Session persistence: DatabaseSessionService (SQLite at
 *      agents/<name>/session-adk.sqlite). Survives restarts. Falls back to
 *      InMemorySessionService if the DB connector fails.
 *  - Per-turn telemetry: usageMetadata harvested from every Event via
 *      UsageAccumulator → computed USD using Gemini 3.5 Flash pricing.
 *  - Images: Discord CDN URL → fetched → base64 inlineData Part. Skips ADK
 *      Artifacts API per gemini's review.
 *  - Streaming: buffer-and-flush pattern matches the SDK runtime's
 *      text_interim semantics.
 *
 * Working directory:
 *  Tools receive workingDir via factory closure. We NEVER call process.chdir().
 *
 * Cost model:
 *  This runtime burns real money on the Gemini API key. No subscription
 *  cap, no $200 wall. a spend cap was vetoed for v1.
 */

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import {
  LlmAgent,
  Runner,
  InMemoryRunner,
  GOOGLE_SEARCH,
  URL_CONTEXT,
  MCPToolset,
  InMemorySessionService,
  DatabaseSessionService,
  type Event,
} from "@google/adk";
import type { Content, Part } from "@google/genai";

import {
  buildSystemPrompt,
  buildSafetyRules,
  buildToolGuidance,
} from "../core/prompt-builder.js";
import { evictedBehaviorFiles } from "../core/state-header.js";
import type {
  AgentConfig,
  AgentMessage,
  ImageAttachment,
  RunAgentResult,
} from "../core/agent.js";
import type { AgentRuntime } from "./types.js";
import { createBasicTools } from "./google-adk/tools/basic-tools.js";
import {
  createBeforeToolCallback,
  createAfterToolCallback,
} from "./google-adk/safety/middleware.js";
import { UsageAccumulator } from "./google-adk/telemetry/usage.js";

// ── Per-agent singletons ─────────────────────────────────────────────
// We instantiate the Runner once per agent (per process). PM2 gives every
// agent its own process, so this is genuinely per-agent.
const runnerCache = new Map<
  string,
  { runner: Runner; agent: LlmAgent; model: string }
>();

const APP_NAME = "hive";
const USER_ID = "owner";

/**
 * Builds (or returns cached) Runner for an agent.
 */
async function getRunner(
  config: AgentConfig,
): Promise<{ runner: Runner; agent: LlmAgent; model: string }> {
  if (runnerCache.has(config.name)) return runnerCache.get(config.name)!;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set in environment — Google ADK runtime requires it.",
    );
  }

  // Model name: pull from config (top-level `model`), but force a Gemini model
  // if a Claude name leaked in.
  let model = config.model;
  if (!model || /claude|opus|sonnet|haiku/i.test(model)) {
    model = "gemini-flash-latest";
  }

  const systemPrompt = buildSystemPrompt({
    agentName: config.name,
    behaviorDir: config.behaviorDir,
    safetyRules: buildSafetyRules(config.safety),
    toolGuidance: buildToolGuidance(),
    // Same single switch as the SDK lane: files in the Session State header
    // (prepended by runAgent before dispatch) are evicted from this prompt.
    evictFiles: evictedBehaviorFiles(config.stateHeader),
  });

  console.log(
    `[adk] System prompt: ${systemPrompt.length} chars, ~${Math.round(systemPrompt.length / 4)} tokens (est)`,
  );

  // Tools: function tools + ADK natives + MCP. Requires gemini-3.x for the
  // GOOGLE_SEARCH / URL_CONTEXT builtins to coexist with FunctionTools — the
  // multi-turn "context circulation" is a Gemini-3 thought-signature feature.
  const tools: any[] = [
    ...createBasicTools({ workingDir: config.workingDir }),
    GOOGLE_SEARCH,
    URL_CONTEXT,
  ];

  // MCP: hive-tools (always). We use the standalone stdio server built for
  // the claude-cli POC (src/tools/hive-tools-mcp-stdio.ts). Same binary, same protocol.
  const hiveCwd = process.cwd();
  tools.push(
    new MCPToolset({
      type: "StdioConnectionParams",
      serverParams: {
        command: "node",
        args: [join(hiveCwd, "dist/tools/hive-tools-mcp-stdio.js")],
        env: {
          ...process.env,
          HIVE_CWD: hiveCwd,
          HIVE_AGENT_NAME: config.name,
          HIVE_BEHAVIOR_DIR: config.behaviorDir,
        },
      },
    } as any),
  );

  // MCP: codex (optional).
  if (config.codex.enabled) {
    tools.push(
      new MCPToolset({
        type: "StdioConnectionParams",
        serverParams: {
          command: config.codex.command,
          args: config.codex.args,
        },
      } as any),
    );
  }

  // MCP: playwright (optional).
  if (config.browser.enabled) {
    const profile = join(hiveCwd, "data", "playwright-profiles", config.name);
    mkdirSync(profile, { recursive: true });
    tools.push(
      new MCPToolset({
        type: "StdioConnectionParams",
        serverParams: {
          command: "npx",
          args: [
            "-y",
            "@playwright/mcp@latest",
            "--user-data-dir",
            profile,
            "--headless",
            "--browser",
            "chromium",
            "--viewport-size",
            "1440x900",
          ],
        },
      } as any),
    );
  }

  // Agent.
  //
  // IMPORTANT — `instruction` is passed as a function, not a raw string.
  // When ADK receives `instruction: string`, it runs the prompt through
  // `injectSessionState` which interprets every `{identifier}` as a session
  // state variable lookup and THROWS if the key is missing. Many of our
  // behavior files contain literal `{X}` patterns (e.g. CODING-STANDARDS
  // uses `{ComponentName}Props` as a naming-convention example).
  //
  // The function-form bypasses templating entirely (see
  // @google/adk/agents/llm_agent.js → canonicalInstruction:
  //   typeof instruction === "string"  → requireStateInjection: true
  //   typeof instruction === "function" → requireStateInjection: false).
  // The first Gemini turn died on `{ComponentName}`; this is the fix.
  const agent = new LlmAgent({
    name: config.name.replace(/-/g, "_"),
    model,
    instruction: () => systemPrompt,
    tools,
    // Required when mixing function-calling tools (our basic-tools + MCP) with
    // builtin tools (GOOGLE_SEARCH, URL_CONTEXT). Without this Gemini returns:
    //   "Please enable tool_config.include_server_side_tool_invocations to
    //    use Built-in tools with Function calling."
    // and the run aborts with zero assistant events. Diagnosed via /tmp/adk-mcp-test.mjs.
    generateContentConfig: {
      toolConfig: {
        includeServerSideToolInvocations: true,
      },
    } as any,
    beforeToolCallback: createBeforeToolCallback(config.safety),
    afterToolCallback: createAfterToolCallback(),
  });

  // Session service: SQLite via DatabaseSessionService (MikroORM). Falls back
  // to InMemory if init throws (e.g. missing sqlite driver).
  const sessionDbDir = join(config.behaviorDir);
  if (!existsSync(sessionDbDir)) mkdirSync(sessionDbDir, { recursive: true });
  const sessionDbPath = join(sessionDbDir, "session-adk.sqlite");

  let sessionService;
  try {
    sessionService = new DatabaseSessionService(`sqlite://${sessionDbPath}`);
    await (sessionService as any).init?.();
    console.log(`[adk] Session DB ready at ${sessionDbPath}`);
  } catch (err) {
    console.error(
      `[adk] DatabaseSessionService init failed (${err}). Falling back to InMemorySessionService — session will NOT persist across restarts.`,
    );
    sessionService = new InMemorySessionService();
  }

  const runner = new Runner({
    appName: APP_NAME,
    agent,
    sessionService,
  });

  runnerCache.set(config.name, { runner, agent, model });
  return { runner, agent, model };
}

/**
 * Ensures a session exists; creates one if needed. Returns the session id.
 */
async function ensureSession(
  runner: Runner,
  desiredId: string | undefined,
  config: AgentConfig,
): Promise<{ sessionId: string; resumed: boolean }> {
  if (desiredId) {
    try {
      const existing = await runner.sessionService.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: desiredId,
      });
      if (existing) return { sessionId: existing.id, resumed: true };
    } catch (err) {
      console.error(`[adk] getSession failed: ${err} — creating new.`);
    }
  }
  const created = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  return { sessionId: created.id, resumed: false };
}

/**
 * Convert a Discord image attachment to a Gemini Part. Downloads the CDN url
 * and inlines as base64 — skips the ADK Artifacts API.
 */
async function imageToPart(img: ImageAttachment): Promise<Part> {
  const res = await fetch(img.url);
  if (!res.ok)
    throw new Error(`Image fetch failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    inlineData: {
      mimeType: img.mediaType,
      data: buf.toString("base64"),
    },
  } as Part;
}

/**
 * Main entry — matches runAgent's signature shape (minus the approval cb,
 * which we don't need: ADK has no permission-mode prompts to dismiss).
 */
export async function runAgentGoogleAdk(
  prompt: string,
  config: AgentConfig,
  onMessage: (msg: AgentMessage) => void,
  sessionId?: string,
  images?: ImageAttachment[],
): Promise<RunAgentResult> {
  let runnerEntry;
  try {
    runnerEntry = await getRunner(config);
  } catch (err) {
    onMessage({ type: "error", content: `[adk] init failed: ${err}` });
    return { sessionId: undefined, usage: undefined, compacted: false };
  }
  const { runner, model } = runnerEntry;
  const session = await ensureSession(runner, sessionId, config);
  const usage = new UsageAccumulator(model);

  // Build the user Content
  const parts: Part[] = [];
  if (images && images.length) {
    for (const img of images) {
      try {
        parts.push(await imageToPart(img));
      } catch (err) {
        console.error(`[adk] image attach failed: ${err}`);
      }
    }
  }
  if (prompt.trim()) parts.push({ text: prompt });
  if (parts.length === 0) parts.push({ text: "(no input)" });

  const newMessage: Content = { role: "user", parts };

  // Buffer-and-flush text matching the SDK runtime semantics.
  let pendingText: string | null = null;
  let finalText: string | null = null;

  const flushPendingAsInterim = () => {
    if (pendingText && pendingText.trim()) {
      onMessage({ type: "text_interim", content: pendingText });
    }
    pendingText = null;
  };

  // Retry-on-failure for resume: if a stale session id blows up, drop it and
  // try fresh. Mirrors the Anthropic runtime's pattern.
  const maxAttempts = sessionId ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stream = runner.runAsync({
        userId: USER_ID,
        sessionId: session.sessionId,
        newMessage,
      });

      for await (const event of stream as AsyncIterable<Event>) {
        const ev = event as any;
        // Surface model errors that ADK delivers as events rather than throws.
        // Without this, a Gemini 4xx becomes a silent zero-turn run and
        // bot.ts posts "(completed with no text output)" to Discord.
        if (ev.errorCode || ev.errorMessage) {
          onMessage({
            type: "error",
            content: `Gemini ${ev.errorCode ?? ""}: ${ev.errorMessage ?? "unknown error"}`,
          });
        }
        usage.recordEvent(ev.usageMetadata);

        const content = ev.content as Content | undefined;
        const partsList = content?.parts ?? [];
        let hasFunctionCall = false;
        const textPieces: string[] = [];

        for (const part of partsList) {
          const p = part as any;
          if (p.functionCall) {
            hasFunctionCall = true;
            const fname = p.functionCall.name ?? "unknown";
            const fargs = p.functionCall.args ?? {};
            onMessage({
              type: "tool_use",
              toolName: fname,
              content: JSON.stringify(fargs).slice(0, 500),
            });
          } else if (p.functionResponse) {
            const fname = p.functionResponse.name ?? "unknown";
            const fresponse = p.functionResponse.response ?? {};
            onMessage({
              type: "tool_result",
              toolName: fname,
              content: JSON.stringify(fresponse).slice(0, 500),
            });
          } else if (p.text) {
            textPieces.push(p.text);
          }
        }

        // If this event has a function call AND we had buffered text, that
        // text was narration — flush as interim.
        if (hasFunctionCall && pendingText !== null) {
          flushPendingAsInterim();
        }

        // Append text pieces. If we already had buffered text and now another
        // text-only block arrived, the previous one was interim.
        if (textPieces.length > 0) {
          const joined = textPieces.join("");
          if (pendingText !== null && !hasFunctionCall) {
            flushPendingAsInterim();
          }
          if (!hasFunctionCall) {
            pendingText = (pendingText ?? "") + joined;
          }
        }

        // turnComplete signals the final assistant turn in this run.
        if ((event as any).turnComplete) {
          if (pendingText && pendingText.trim()) {
            finalText = pendingText;
            pendingText = null;
          }
        }
      }

      // End-of-stream: whatever is still buffered is the final reply.
      if (pendingText && pendingText.trim()) {
        finalText = pendingText;
        pendingText = null;
      }

      if (finalText) {
        onMessage({ type: "text", content: finalText });
      }

      break; // success — exit retry loop
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        console.error(
          `[adk] runAsync failed on attempt ${attempt}: ${msg} — retrying with fresh session.`,
        );
        const fresh = await runner.sessionService.createSession({
          appName: APP_NAME,
          userId: USER_ID,
        });
        session.sessionId = fresh.id;
        onMessage({
          type: "system",
          content: "⚠️ Session resume failed — starting fresh session.",
        });
        continue;
      }
      onMessage({ type: "error", content: `[adk] ${msg}` });
    }
  }

  // ── Post-turn session sanitation ────────────────────────────────────
  // ADK persists every event verbatim into the SQLite session DB, including
  // multi-MB inline_data base64 from image attachments. Every subsequent
  // turn replays the whole session, so one image = permanent context tax.
  //
  // Strip inline_data payloads from the session DB AFTER the turn that
  // consumed them — the model has already seen the image on its first
  // pass; future turns just need a placeholder.
  try {
    const sessionDbPath = join(config.behaviorDir, "session-adk.sqlite");
    if (existsSync(sessionDbPath)) {
      await stripImagesFromSessionDb(sessionDbPath, session.sessionId);
    }
  } catch (err) {
    console.error(`[adk] post-turn session sanitation failed: ${err}`);
  }

  const finalUsage = usage.finalize();
  console.log(
    `[adk-usage] ${finalUsage.inputTokens.toLocaleString()} in / ${finalUsage.outputTokens.toLocaleString()} out` +
      ` | cached: ${finalUsage.cacheReadTokens.toLocaleString()}` +
      ` | $${finalUsage.costUSD.toFixed(4)}` +
      ` | ${finalUsage.numTurns} turns | ${(finalUsage.durationMs / 1000).toFixed(1)}s`,
  );

  return {
    sessionId: session.sessionId,
    usage: finalUsage,
    compacted: false, // ADK manages its own context; we don't surface a flag yet
  };
}

/**
 * Walks the session DB and rewrites any event whose JSON payload contains
 * inline_data, replacing the base64 data with a tiny placeholder.
 *
 * Trade-off: the image is consumed on the turn it arrives (model sees the
 * full thing), then becomes "[image processed]" in future replays. Same
 * effect as the Anthropic SDK's automatic context trimming, just manual.
 *
 * Why not Artifacts? They add a cloud round-trip with no benefit when we
 * just need to drop the data once the model is done with it.
 */
async function stripImagesFromSessionDb(
  dbPath: string,
  sessionId: string,
): Promise<void> {
  const { default: Database } = await import("better-sqlite3").catch(
    () => ({ default: null as any }),
  );
  if (!Database) {
    // better-sqlite3 isn't installed — fall back to spawning sqlite3 cli.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    // Replace any data: "...." inside inline_data blocks with placeholder.
    // Using JSON path operators would be cleaner but sqlite3 cli is what we have.
    const sql =
      `UPDATE events SET event_data = ` +
      `replace(event_data, ` +
      `  substr(event_data, ` +
      `    instr(event_data, '"inline_data":{"mime_type":') ` +
      `  ), ` +
      `  '"inline_data":{"mime_type":"image/placeholder","data":"[image processed - data stripped post-turn]"}}' ` +
      `) ` +
      `WHERE session_id = ? AND event_data LIKE '%inline_data%' ` +
      `AND length(event_data) > 5000`;
    // The substring trick above is fragile across rows of differing shapes,
    // so fall back to a simpler scoped REPLACE that just blanks the base64
    // (everything between '"data":"' and the next '"') with a marker.
    // Use a per-row Python-style approach via the sqlite3 binary.
    await exec("sqlite3", [
      dbPath,
      `UPDATE events SET event_data = json_replace(event_data, '$.content.parts[0].inline_data.data', '[stripped]') WHERE session_id = '${sessionId}' AND event_data LIKE '%inline_data%' AND length(event_data) > 5000;`,
    ]).catch(() => {});
    return;
  }
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT id, app_name, user_id, event_data FROM events WHERE session_id = ? AND event_data LIKE '%inline_data%' AND length(event_data) > 5000",
      )
      .all(sessionId) as Array<{
      id: string;
      app_name: string;
      user_id: string;
      event_data: string;
    }>;
    if (rows.length === 0) return;
    const update = db.prepare(
      "UPDATE events SET event_data = ? WHERE id = ? AND app_name = ? AND user_id = ? AND session_id = ?",
    );
    let stripped = 0;
    let bytesSaved = 0;
    for (const row of rows) {
      let payload: any;
      try {
        payload = JSON.parse(row.event_data);
      } catch {
        continue;
      }
      const parts = payload?.content?.parts;
      if (!Array.isArray(parts)) continue;
      let changed = false;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const inline = part?.inline_data ?? part?.inlineData;
        if (inline && typeof inline.data === "string" && inline.data.length > 200) {
          bytesSaved += inline.data.length;
          // Replace the ENTIRE inline_data part with a plain text part.
          // Leaving inline_data with a non-base64 string causes Gemini to
          // 400 with "Base64 decoding failed" on every subsequent turn.
          parts[i] = {
            text: `[image processed on prior turn — ${Math.round(inline.data.length / 1024)} KB stripped to save context]`,
          };
          changed = true;
        }
      }
      if (changed) {
        update.run(
          JSON.stringify(payload),
          row.id,
          row.app_name,
          row.user_id,
          sessionId,
        );
        stripped++;
      }
    }
    if (stripped > 0) {
      console.log(
        `[adk-sanitize] stripped ${stripped} image(s) from session, freed ~${Math.round(bytesSaved / 1024)} KB`,
      );
    }
  } finally {
    db.close();
  }
}

/** AgentRuntime wrapper for the registry (src/runtimes/registry.ts). */
export const googleAdkRuntime: AgentRuntime = {
  name: "google-adk",
  // Note: the ADK path has no approval callback today (same as before the
  // extraction) — onApprovalRequired is intentionally unused.
  run: (o) => runAgentGoogleAdk(o.prompt, o.config, o.onMessage, o.sessionId, o.images),
};
