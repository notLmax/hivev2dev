/**
 * agent.ts
 * Core agent types, config resolution, and the runAgent() facade.
 *
 * runAgent() = Session State header prepend → runtime registry dispatch
 * (src/runtimes/). The Claude Agent SDK path lives in
 * src/runtimes/claude-sdk-runtime.ts.
 */

import { type SystemPromptMeta } from "./prompt-builder.js";
import {
  buildStateHeader,
  parseStateHeaderConfig,
  evictedBehaviorFiles,
  type StateHeaderConfig,
} from "./state-header.js";
import { getRuntime } from "../runtimes/registry.js";
import type { RuntimeName } from "../runtimes/types.js";
import { loadModelCatalog, resolveModel, type ResolvedModel } from "./model-catalog.js";
import { computeCostUSD } from "../billing/pricing.js";
import { checkSpendCaps } from "../billing/spend-caps.js";
import { addSpend } from "../billing/spend-rollup.js";
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

export interface AgentConfig {
  name: string;
  behaviorDir: string;
  memoryDir: string;
  model: string;
  workingDir: string;
  codex: { enabled: boolean; command: string; args: string[] };
  /** Per-agent visual browser capability via Playwright MCP. */
  browser: { enabled: boolean };
  /**
   * Per-agent webhook ingress: external Discord webhooks whose messages should
   * be treated as legitimate user input (routed through the same handler as
   * the owner's messages). Used for external wake hooks (e.g. a quality-gate webhook).
   * Match is by Discord webhook ID (the numeric ID in the webhook URL path).
   */
  webhookIngress: { allowedIds: string[] };
  safety: {
    blocked_commands: string[];
    allowed_paths: string[];
    protected_paths: string[];
  };
  /**
   * Runtime backend for the agent's main turns (src/runtimes/types.ts).
   * Config value "sdk" is a legacy alias for "claude-agent-sdk", normalized
   * in resolveAgentConfig.
   */
  runtime: RuntimeName;
  /**
   * Session State header config (Queen Bee 04 §4.2) — which mutable files are
   * evicted from the system prompt and ride the per-message header instead.
   * From the additive `state_header:` yaml block (global + per-agent overlay).
   */
  stateHeader: StateHeaderConfig;
  /**
   * Catalog resolution result (config/models.yaml, 04 §3): pinned ID,
   * endpoint, pricing, tier, caps. Present whenever a catalog entry was used;
   * absent on raw passthrough. `model`/`runtime` above already carry the
   * resolved values — downstream code needs no catalog awareness.
   */
  modelInfo?: ResolvedModel;
}

export interface AgentMessage {
  type: "text" | "text_interim" | "tool_use" | "tool_result" | "error" | "system";
  content: string;
  toolName?: string;
}

export interface ImageAttachment {
  url: string; // Discord CDN URL — Anthropic API fetches directly
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

/** Per-query usage data extracted from the SDK result message. */
export interface QueryUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  contextWindow: number;
  maxOutputTokens: number;
  /** Input tokens from the LAST API call only — actual context window fill level. */
  lastTurnInputTokens: number;
}

/** Per-turn usage summary, also persisted to data/turns.jsonl (Queen Bee 04 §4.0). */
export interface TurnSummary {
  turn: number;
  input: number;
  cacheRead: number;
  cacheCreate: number;
}

/** Return value from runAgent — session ID + usage data. */
export interface RunAgentResult {
  sessionId?: string;
  usage?: QueryUsage;
  compacted: boolean; // true if any context edit happened during this query
  /**
   * Context-editing detail behind `compacted` (04 §4.8): SDK auto-compaction
   * (claude lane) or client-side budget enforcement (compat lane). Absent
   * when nothing was edited. Persisted to usage.jsonl by bot.ts logUsage.
   */
  contextEdits?: {
    compactions: number;
    compactionPreTokens?: number;
    prunedToolResults: number;
    droppedMessages: number;
  };
  /** Prompt-assembly telemetry. Present on the claude-agent-sdk path. */
  promptMeta?: SystemPromptMeta & { queryId: string; headerChars?: number };
  /** Per-turn cache telemetry. Present on the claude-agent-sdk path. */
  turns?: TurnSummary[];
  /**
   * Billing summary attached by the runAgent facade (04 §5). When catalog
   * pricing is available, usage.costUSD is the COMPUTED figure and the
   * runtime's client-side estimate is preserved in costUsdReported.
   */
  billing?: {
    runtime: RuntimeName;
    catalogKey?: string;
    tier?: string;
    costUsdComputed?: number;
    costUsdReported?: number;
  };
}

type ApprovalCallback = (message: string) => Promise<boolean>;

/**
 * Loads and parses the global config file.
 */
export function loadConfig(configPath: string): Record<string, unknown> {
  const raw = readFileSync(configPath, "utf-8");
  return yaml.load(raw) as Record<string, unknown>;
}

/**
 * Sends a prompt to the agent and streams responses back.
 *
 * Facade: prepends the Session State header, then dispatches to the agent's
 * runtime via the registry. Signature is unchanged from the pre-extraction
 * version — all callers (bot.ts ×4, scripts) are untouched.
 */
export async function runAgent(
  prompt: string,
  config: AgentConfig,
  onMessage: (msg: AgentMessage) => void,
  onApprovalRequired: ApprovalCallback,
  sessionId?: string,
  images?: ImageAttachment[]
): Promise<RunAgentResult> {
  // Session State header (Queen Bee 04 §4.2): mutable agent state rides on the
  // latest user message, never in the system prompt. Prepended HERE — not in
  // the callers — so every entry point (Discord, hivemind, codex wake, cron)
  // and every runtime gets identical state, and a failed session resume still
  // reloads state on the fresh session's first message.
  const sh = config.stateHeader;
  const stateHeader = buildStateHeader({
    memoryDir: config.memoryDir,
    behaviorDir: config.behaviorDir,
    agentName: config.name,
    dailyMemoryDays: sh.dailyMemoryDays,
    maxSectionChars: sh.maxSectionChars,
    behaviorFiles: evictedBehaviorFiles(sh),
    includeCodexTasks: sh.includeCodexTasks,
    codexTasksLimit: sh.codexTasksLimit,
  });
  const fullPrompt = stateHeader + prompt;

  // Spend caps (04 §5) — enforced HERE, the single chokepoint covering every
  // entry path. No caps configured (every agent without a models.yaml
  // assignment) → always ok.
  const capDecision = checkSpendCaps(config.name, config.modelInfo?.caps);
  if (capDecision.state === "warn") {
    onMessage({ type: "system", content: `⚠️ ${capDecision.message}` });
  } else if (capDecision.state === "stop") {
    console.error(`[spend-caps] ${config.name}: ${capDecision.message}`);
    onMessage({ type: "error", content: `🛑 ${capDecision.message}` });
    return { compacted: false };
  }

  const runtime = await getRuntime(config.runtime);
  const result = await runtime.run({
    prompt: fullPrompt,
    config,
    onMessage,
    onApprovalRequired,
    sessionId,
    images,
  });

  // headerChars telemetry lives here because only the facade knows the header.
  if (result.promptMeta) {
    result.promptMeta.headerChars = stateHeader.length;
  }

  // Billing (04 §5): catalog pricing overrides the runtime's client-side
  // estimate (both are logged; neither is authoritative vs the console).
  // Spend rollup feeds the caps above and /status.
  const usage = result.usage;
  const costUsdReported = usage?.costUSD;
  let costUsdComputed: number | undefined;
  if (usage && config.modelInfo?.price) {
    costUsdComputed = computeCostUSD(usage, config.modelInfo.price);
    usage.costUSD = costUsdComputed;
  }
  result.billing = {
    runtime: config.runtime,
    catalogKey: config.modelInfo?.catalogKey,
    tier: config.modelInfo?.tier,
    costUsdComputed,
    costUsdReported,
  };
  if (usage) {
    addSpend(config.name, usage.costUSD);
  }
  return result;
}

/**
 * Resolves agent config from the global config and agent name.
 */
export function resolveAgentConfig(
  globalConfig: Record<string, unknown>,
  agentName: string
): AgentConfig {
  const agents = globalConfig.agents as Record<string, Record<string, unknown>>;
  const agentDef = agents[agentName];
  if (!agentDef) throw new Error(`Agent "${agentName}" not found in config`);

  const safety = globalConfig.safety as AgentConfig["safety"];
  const codex = globalConfig.codex as AgentConfig["codex"];
  // Per-agent model override wins; fall back to the global default. This lets
  // Gemini-backed agents (e.g. Big Head with `model: gemini-2.5-flash`)
  // coexist with Claude-backed agents under the same global default.
  const model = ((agentDef.model as string | undefined) ?? globalConfig.model) as string;
  const behaviorDir = join(process.cwd(), agentDef.behavior_dir as string);
  const memoryDir = join(behaviorDir, "memory");

  // "sdk" is the legacy config alias for the Agent SDK runtime. The
  // normalized name is never persisted anywhere — config-file values stay
  // whatever the owner wrote.
  const runtimeWasExplicit = agentDef.runtime !== undefined;
  const runtimeRaw = (agentDef.runtime as string | undefined) ?? "sdk";
  let runtime: RuntimeName = "claude-agent-sdk";
  if (runtimeRaw === "claude-cli") runtime = "claude-cli";
  else if (runtimeRaw === "google-adk") runtime = "google-adk";
  else if (runtimeRaw === "anthropic-compat") runtime = "anthropic-compat";

  // Model catalog (config/models.yaml, 04 §3). Absent file or non-matching
  // model string → passthrough, byte-identical to pre-catalog behavior.
  // Broken assignments for THIS agent throw here — loud at startup, not at
  // first turn.
  const resolved = resolveModel(loadModelCatalog(), agentName, model, runtime, runtimeWasExplicit);

  // Per-agent browser capability — read from agent block in config.yaml, e.g.
  //   my-agent:
  //     browser:
  //       enabled: true
  const browserBlock = (agentDef.browser as { enabled?: boolean } | undefined);
  const browser = { enabled: browserBlock?.enabled === true };

  const webhookBlock = (agentDef.webhook_ingress as { allowed_ids?: string[] } | undefined);
  const webhookIngress = { allowedIds: webhookBlock?.allowed_ids ?? [] };

  // Session State header config — additive `state_header:` block, global with
  // per-agent overlay; absent block = defaults (full mutable-file eviction).
  const stateHeader = parseStateHeaderConfig(
    globalConfig.state_header as Record<string, unknown> | undefined,
    agentDef.state_header as Record<string, unknown> | undefined
  );

  return {
    name: agentName,
    behaviorDir,
    memoryDir,
    model: resolved.modelId,
    workingDir: process.env.WORKING_DIR || join(process.env.HOME || "/tmp", "projects"),
    codex,
    browser,
    webhookIngress,
    safety,
    runtime: resolved.runtime,
    stateHeader,
    modelInfo: resolved.catalogKey ? resolved : undefined,
  };
}
