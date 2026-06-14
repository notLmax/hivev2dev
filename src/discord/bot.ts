/**
 * bot.ts
 * Discord bot for a single agent.
 * Each agent runs its own bot process with its own token.
 */

import {
  Client,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
  Partials,
  REST,
  Routes,
  Events,
  AttachmentBuilder,
} from "discord.js";
import { runAgent, resolveAgentConfig, loadConfig } from "../core/agent.js";
import type { AgentMessage, ImageAttachment, RunAgentResult } from "../core/agent.js";
import { appendQueryUsage } from "../core/telemetry.js";
import { getSpend } from "../billing/spend-rollup.js";
import { loadModelCatalog, assignAgentModel, type SpendCaps } from "../core/model-catalog.js";
import { appendFileSync } from "fs";
import { listTasks, updateTask, isSessionAlive, captureOutput, getDiffSummary, type CodexTask } from "../tools/codex-tasks.js";
import { isNoReply, relayLoopGuardTripped } from "./relay-guards.js";
import { isHivemindResponsePending, setHivemindProcessing, initDelegationRegistry } from "../tools/messaging.js";
import { setAgentExecutor } from "../tools/cron.js";
import { join, basename } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from "fs";
import { pipeline } from "stream/promises";

interface BotOptions {
  token: string;
  ownerId: string;
  configPath: string;
  agentName: string;
}

// ── Session Stats ──────────────────────────────────────────────
interface SessionStats {
  sessionStarted: Date;
  lastActivity: Date;
  interactions: number;
  compactions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalTurns: number;
  totalDurationMs: number;
  // From the most recent query (for "current context" approximation)
  // lastContextTokens = inputTokens + cacheReadTokens (total tokens sent to model)
  lastContextTokens: number;
  lastOutputTokens: number;
  contextWindow: number;
  model: string;
  // ── Queen Bee cache trend (04 §4.0) ──
  /** Per-turn cache read:create ratios, most recent last. Ring buffer, cap 50. */
  recentTurnRatios: number[];
  /** System-prompt hash from the most recent query. */
  lastPromptHash?: string;
  /** Consecutive queries with an unchanged prompt hash. */
  promptHashStreak: number;
}

function createSessionStats(model: string): SessionStats {
  return {
    sessionStarted: new Date(),
    lastActivity: new Date(),
    interactions: 0,
    compactions: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUSD: 0,
    totalTurns: 0,
    totalDurationMs: 0,
    lastContextTokens: 0,
    lastOutputTokens: 0,
    contextWindow: 200_000,
    model,
    recentTurnRatios: [],
    promptHashStreak: 0,
  };
}

const TURN_RATIO_BUFFER_CAP = 50;

function updateStats(stats: SessionStats, result: RunAgentResult): void {
  stats.interactions++;
  stats.lastActivity = new Date();
  if (result.compacted) stats.compactions++;

  const usage = result.usage;
  if (usage) {
    stats.totalInputTokens += usage.inputTokens;
    stats.totalOutputTokens += usage.outputTokens;
    stats.totalCacheReadTokens += usage.cacheReadTokens;
    stats.totalCacheCreationTokens += usage.cacheCreationTokens;
    stats.totalCostUSD += usage.costUSD;
    stats.totalTurns += usage.numTurns;
    stats.totalDurationMs += usage.durationMs;
    stats.lastContextTokens = usage.lastTurnInputTokens;
    stats.lastOutputTokens = usage.outputTokens;
    stats.contextWindow = usage.contextWindow;
  }

  // Queen Bee cache trend (04 §4.0): in-memory mirrors of the jsonl telemetry.
  for (const t of result.turns ?? []) {
    const total = t.cacheRead + t.cacheCreate;
    if (total > 0) {
      stats.recentTurnRatios.push(t.cacheRead / total);
      if (stats.recentTurnRatios.length > TURN_RATIO_BUFFER_CAP) {
        stats.recentTurnRatios.shift();
      }
    }
  }
  const hash = result.promptMeta?.hash;
  if (hash) {
    stats.promptHashStreak = hash === stats.lastPromptHash ? stats.promptHashStreak + 1 : 1;
    stats.lastPromptHash = hash;
  }
}

function formatSpendLine(agentName: string, caps?: SpendCaps): string {
  const spend = getSpend(agentName);
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected = (spend.monthly.usd / now.getDate()) * daysInMonth;
  const dailyCap = caps?.dailyUSD !== undefined ? ` / cap $${caps.dailyUSD.toFixed(2)}` : "";
  const monthlyCap = caps?.monthlyUSD !== undefined ? ` / cap $${caps.monthlyUSD.toFixed(2)}` : "";
  return (
    `💸 Spend: $${spend.daily.usd.toFixed(2)} today${dailyCap} · ` +
    `$${spend.monthly.usd.toFixed(2)} month${monthlyCap} · proj $${projected.toFixed(2)}`
  );
}

function formatStats(
  stats: SessionStats,
  agentName: string,
  sessionId: string | undefined,
  caps?: SpendCaps
): string {
  const cacheTotal = stats.totalCacheReadTokens + stats.totalCacheCreationTokens;
  const cacheHitPct = cacheTotal > 0
    ? Math.round((stats.totalCacheReadTokens / cacheTotal) * 100)
    : 0;

  // Total input = non-cached + cached (full picture of what was sent to the model)
  const totalIn = stats.totalInputTokens + stats.totalCacheReadTokens;

  const contextPct = stats.contextWindow > 0
    ? Math.round((stats.lastContextTokens / stats.contextWindow) * 100)
    : 0;

  const elapsed = Date.now() - stats.sessionStarted.getTime();
  const elapsedStr = formatDuration(elapsed);

  const shortSessionId = sessionId
    ? sessionId.substring(0, 8)
    : "none";

  // Queen Bee cache trend (04 §4.0): hit-rate over the last N turns + prompt
  // hash stability. "stable ×N" = N consecutive queries with an unchanged
  // system prompt (the cacheable prefix isn't churning).
  const lastN = stats.recentTurnRatios.slice(-10);
  const trendPct = lastN.length > 0
    ? Math.round((lastN.reduce((a, b) => a + b, 0) / lastN.length) * 100)
    : null;
  const trendLine = trendPct === null
    ? `📈 Cache trend: no turns yet`
    : `📈 Cache trend: ${trendPct}% last ${lastN.length} turns · prompt ${stats.lastPromptHash ?? "?"} (stable ×${stats.promptHashStreak})`;

  const lines = [
    `🐝 **Neato Hive** — ${agentName}`,
    `🧠 Model: ${stats.model}`,
    `🧮 Tokens: ${formatTokens(totalIn)} in / ${formatTokens(stats.totalOutputTokens)} out`,
    `🗄️ Cache: ${cacheHitPct}% hit · ${formatTokens(stats.totalCacheReadTokens)} cached, ${formatTokens(stats.totalCacheCreationTokens)} new`,
    trendLine,
    formatSpendLine(agentName, caps),
    `📚 Context: ${formatTokens(stats.lastContextTokens)}/${formatTokens(stats.contextWindow)} (${contextPct}%) · 🧹 Context edits: ${stats.compactions}`,
    `🧵 Session: ${shortSessionId} · ${stats.interactions} interactions · up ${elapsedStr}`,
    `⚙️ Think: adaptive · 💰 Cost: $${stats.totalCostUSD.toFixed(4)}`,
  ];

  return lines.join("\n");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMins}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

/**
 * Logs usage to a persistent file for historical tracking.
 * Appends one JSON line per interaction (data/usage.jsonl). Legacy fields keep
 * their names; prompt-hash telemetry (Queen Bee 04 §4.0) rides as optional
 * additions via src/core/telemetry.ts.
 */
function logUsage(agentName: string, result: RunAgentResult, model?: string): void {
  const usage = result.usage;
  if (!usage) return;
  appendQueryUsage({
    timestamp: new Date().toISOString(),
    agent: agentName,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUSD: usage.costUSD,
    numTurns: usage.numTurns,
    durationMs: usage.durationMs,
    queryId: result.promptMeta?.queryId,
    sessionId: result.sessionId,
    model,
    runtime: result.billing?.runtime,
    catalogKey: result.billing?.catalogKey,
    tier: result.billing?.tier,
    costUsdComputed: result.billing?.costUsdComputed,
    costUsdReported: result.billing?.costUsdReported,
    promptHash: result.promptMeta?.hash,
    promptChars: result.promptMeta?.chars,
    headerChars: result.promptMeta?.headerChars,
    sectionHashes: result.promptMeta?.sectionHashes,
    fileHashes: result.promptMeta?.fileHashes,
    // Context-editing telemetry (04 §4.8) — undefined fields are dropped by
    // JSON.stringify, so unedited queries carry no extra bytes.
    compactions: result.contextEdits?.compactions,
    compactionPreTokens: result.contextEdits?.compactionPreTokens,
    prunedToolResults: result.contextEdits?.prunedToolResults,
    droppedMessages: result.contextEdits?.droppedMessages,
  });
}

// ── Session Persistence ────────────────────────────────────────

function sessionFilePath(agentName: string): string {
  return join(process.cwd(), "agents", agentName, "session.json");
}

function loadSession(agentName: string): string | undefined {
  try {
    const file = sessionFilePath(agentName);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8"));
      return data.sessionId;
    }
  } catch {}
  return undefined;
}

function saveSession(agentName: string, sessionId: string): void {
  try {
    writeFileSync(
      sessionFilePath(agentName),
      JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error("[sessions] Failed to save:", err);
  }
}

function clearSession(agentName: string): void {
  try {
    writeFileSync(
      sessionFilePath(agentName),
      JSON.stringify({ sessionId: "", updatedAt: new Date().toISOString(), clearedBy: "crash-protection" }, null, 2)
    );
    console.log(`[sessions] Session cleared for ${agentName} (crash protection)`);
  } catch (err) {
    console.error("[sessions] Failed to clear:", err);
  }
}

// ── Daily Memory Header — moved (Queen Bee 04 §4.2) ───────────
//
// The per-message state injection now lives in src/core/state-header.ts and
// is prepended centrally inside runAgent(), so every entry point (Discord,
// hivemind, codex wake, cron) and every runtime carries identical state.
// Do NOT prepend state to prompts here.

// ── Runtime State (per-agent toggles) ──────────────────────────
//
// Small persisted flags that survive restart but aren't part of version control.
// Currently tracks the /show-thinking toggle. Stored alongside session.json in
// each agent's directory.

interface RuntimeState {
  /** When true, interim checkpoint narration is posted as Discord subtext above the final reply. Default false. */
  showThinking: boolean;
}

function runtimeFilePath(agentName: string): string {
  return join(process.cwd(), "agents", agentName, "runtime.json");
}

function loadRuntime(agentName: string): RuntimeState {
  try {
    const file = runtimeFilePath(agentName);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8")) as Partial<RuntimeState>;
      return { showThinking: data.showThinking === true };
    }
  } catch (err) {
    console.error("[runtime] Failed to load, using defaults:", err);
  }
  return { showThinking: false };
}

function saveRuntime(agentName: string, state: RuntimeState): void {
  try {
    writeFileSync(
      runtimeFilePath(agentName),
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error("[runtime] Failed to save:", err);
  }
}

// ── Crash Loop Detection ───────────────────────────────────────

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

function detectCrashLoop(agentName: string): boolean {
  const crashFile = join(process.cwd(), "agents", agentName, "crash-detect.json");
  const now = Date.now();
  let timestamps: number[] = [];

  try {
    if (existsSync(crashFile)) {
      const parsed = JSON.parse(readFileSync(crashFile, "utf-8"));
      if (Array.isArray(parsed)) timestamps = parsed;
    }
  } catch {}

  if (!Array.isArray(timestamps)) timestamps = [];
  timestamps = timestamps.filter((t) => typeof t === "number" && now - t < CRASH_LOOP_WINDOW_MS);
  timestamps.push(now);

  try {
    writeFileSync(crashFile, JSON.stringify(timestamps));
  } catch {}

  if (timestamps.length >= CRASH_LOOP_THRESHOLD) {
    console.error(`[crash-protection] ${timestamps.length} restarts in ${CRASH_LOOP_WINDOW_MS / 1000}s — crash loop detected`);
    return true;
  }

  return false;
}

// ── Attachment Handling ────────────────────────────────────────

const ATTACHMENTS_DIR = "/tmp/hive-attachments";
const ATTACH_PATTERN = /\[ATTACH:([^\]]+)\]/g;

async function downloadAttachment(url: string, filename: string): Promise<string> {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const localPath = join(ATTACHMENTS_DIR, `${Date.now()}-${filename}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${filename}: ${response.statusText}`);
  }
  const fileStream = createWriteStream(localPath);
  // @ts-ignore — Node 24 ReadableStream is compatible with pipeline
  await pipeline(response.body as any, fileStream);
  return localPath;
}

function extractAttachments(text: string): { cleanText: string; filePaths: string[] } {
  const filePaths: string[] = [];
  const cleanText = text.replace(ATTACH_PATTERN, (_match, path) => {
    filePaths.push(path.trim());
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, filePaths };
}

// ── Approval Flow ──────────────────────────────────────────────

const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }
>();

// ── Message Splitting ──────────────────────────────────────────

function splitMessage(content: string, maxLength = 1900): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      splitIdx = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIdx === -1) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ── Send Response Helper ───────────────────────────────────────

async function sendToChannel(
  channel: TextChannel | ThreadChannel,
  text: string,
  discordFiles?: AttachmentBuilder[]
): Promise<void> {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i === chunks.length - 1 && discordFiles && discordFiles.length > 0) {
      await channel.send({ content: chunks[i], files: discordFiles });
    } else {
      await channel.send(chunks[i]);
    }
  }
}

// ════════════════════════════════════════════════════════════════
// ██  START BOT  ████████████████████████████████████████████████
// ════════════════════════════════════════════════════════════════

export async function startBot(options: BotOptions): Promise<Client> {
  const { token, ownerId, configPath, agentName } = options;
  const config = loadConfig(configPath);
  // `let` — /swap re-resolves after changing the models.local.yaml assignment.
  let agentConfig = resolveAgentConfig(config, agentName);
  // Honor per-agent model override (resolveAgentConfig falls back to global).
  // Without this, /status shows the global default for every agent regardless
  // of runtime — e.g. Gemini-backed agents falsely report claude-opus-4-7.
  const model = agentConfig.model || (config.model as string) || "claude-opus-4-7";

  // Get the channels this agent listens to
  const agents = config.agents as Record<string, { channels: string[] }>;
  const agentDef = agents[agentName];
  if (!agentDef) {
    console.error(`Agent "${agentName}" not found in config.yaml`);
    process.exit(1);
  }
  const allowedChannels = new Set(agentDef.channels);

  // Load persisted session — with crash loop protection
  let currentSessionId = loadSession(agentName);

  if (currentSessionId && detectCrashLoop(agentName)) {
    console.error(`[crash-protection] Clearing session for ${agentName} to break crash loop`);
    clearSession(agentName);
    currentSessionId = undefined;
  }

  if (currentSessionId) {
    console.log(`[sessions] Resuming session ${currentSessionId.substring(0, 8)}...`);
  }

  // Runtime toggles (persisted) — /show-thinking, etc.
  const runtimeState = loadRuntime(agentName);
  console.log(`[runtime] show-thinking: ${runtimeState.showThinking ? "on" : "off"}`);

  // Hivemind delegation registry (persisted) — restores in-flight delegations
  // from disk so a PM2 restart mid-conversation doesn't drop them.
  initDelegationRegistry(agentName);

  // Session stats — tracks token usage, cache, compactions, cost
  let sessionStats = createSessionStats(model);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once("ready", async () => {
    console.log(`[discord] Logged in as ${client.user?.tag}`);
    console.log(`[discord] Owner: ${ownerId}`);
    console.log(`[discord] Channels: ${[...allowedChannels].join(", ")}`);

    // Register slash commands
    const rest = new REST().setToken(token);
    try {
      await rest.put(
        Routes.applicationCommands(client.user!.id),
        {
          body: [
            { name: "newsession", description: "Start a fresh conversation session" },
            { name: "status", description: "Show agent status — tokens, cache, context, cost" },
            { name: "show-thinking", description: "Toggle visible checkpoint narration above replies" },
            {
              name: "swap",
              description: "Swap this agent to another catalog model (memory-bridge handoff, fresh session)",
              options: [
                {
                  name: "model",
                  description: "Catalog key from config/models.yaml (e.g. sonnet, ollama-deepseek)",
                  type: 3, // STRING
                  required: true,
                },
              ],
            },
          ]
        }
      );
      console.log("[discord] Registered slash commands: /newsession, /status, /show-thinking, /swap");
    } catch (err) {
      console.error("[discord] Failed to register slash commands:", err);
    }
  });

  // ── Slash Command Handling ──
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== ownerId) return;

    if (interaction.commandName === "newsession") {
      currentSessionId = undefined;
      saveSession(agentName, "");
      sessionStats = createSessionStats(model); // Reset stats
      // For claude-cli runtime: also kill the agent's tmux session so the
      // interactive claude process is killed and a fresh one spawns next turn.
      if (agentConfig.runtime === "claude-cli") {
        try {
          const { killSession } = await import("../runtimes/claude-cli-runtime.js");
          killSession(agentName);
        } catch (e) {
          console.error(`[newsession] Failed to kill tmux session:`, e);
        }
      }
      await interaction.reply("Session cleared. Next message starts fresh.");
    }

    if (interaction.commandName === "status") {
      const statusText = formatStats(
        sessionStats,
        agentName,
        currentSessionId,
        agentConfig.modelInfo?.caps
      );
      await interaction.reply(statusText);
    }

    if (interaction.commandName === "swap") {
      // Live model swap (06-ROLLOUT-PLAYBOOK §2): everything durable —
      // personality, MEMORY/TASKS/LESSONS, daily memory — is model-agnostic
      // and rides the Session State header onto ANY runtime. Only the
      // in-flight transcript is runtime-bound, so we bridge it: the CURRENT
      // model writes a handoff note into daily memory, then the new model
      // starts a fresh session that reads it via the state header.
      const key = interaction.options.getString("model", true);
      await interaction.deferReply();
      const catalog = loadModelCatalog();
      if (!catalog?.entries[key]) {
        const available = catalog ? Object.keys(catalog.entries).join(", ") : "(no models.yaml)";
        await interaction.editReply(`Unknown catalog model \`${key}\`. Available: ${available}`);
        return;
      }
      const prevModel = agentConfig.model;
      const prevAssignment = assignAgentModel(agentName, key); // returns prior key for revert
      try {
        // 1. Memory bridge — only when there is a conversation to hand off.
        let handoff = "";
        if (currentSessionId) {
          await runAgent(
            `You are about to be swapped to a different model ("${key}"). Reply ONLY with a concise ` +
              `handoff note (bullet points) covering open threads, recent decisions, and anything ` +
              `in-flight in this conversation that your successor needs to continue seamlessly.`,
            agentConfig,
            (m: AgentMessage) => {
              if (m.type === "text") handoff = m.content;
            },
            async () => false,
            currentSessionId
          );
        }
        if (handoff.trim()) {
          const today = new Date().toISOString().slice(0, 10);
          mkdirSync(agentConfig.memoryDir, { recursive: true });
          appendFileSync(
            join(agentConfig.memoryDir, `${today}.md`),
            `\n## Model swap handoff (${prevModel} → ${key})\n\n${handoff.trim()}\n`
          );
        }

        // 2. Re-resolve with the new assignment — throws loudly on a broken
        //    one (missing API key, runtime conflict) before anything is lost.
        agentConfig = resolveAgentConfig(loadConfig(configPath), agentName);

        // 3. Fresh session on the new model; state header restores context.
        currentSessionId = undefined;
        saveSession(agentName, "");
        sessionStats = createSessionStats(agentConfig.model);

        await interaction.editReply(
          `🔄 Swapped to **${key}** → \`${agentConfig.model}\` (runtime: ${agentConfig.runtime}).` +
            (handoff.trim() ? " Handoff note written to daily memory." : "") +
            " Next message starts a fresh session carrying full state."
        );
      } catch (e) {
        // Revert the assignment — a broken swap must never brick the agent.
        try {
          assignAgentModel(agentName, prevAssignment);
          agentConfig = resolveAgentConfig(loadConfig(configPath), agentName);
        } catch {}
        await interaction.editReply(
          `Swap failed: ${e instanceof Error ? e.message : String(e)} — assignment reverted to ${prevAssignment ?? "(no assignment)"}.`
        );
      }
    }

    if (interaction.commandName === "show-thinking") {
      runtimeState.showThinking = !runtimeState.showThinking;
      saveRuntime(agentName, runtimeState);
      await interaction.reply(
        runtimeState.showThinking
          ? "Thinking visible: **on**. You'll see checkpoint narration as subtext above my replies."
          : "Thinking visible: **off**. Back to final replies only."
      );
    }
  });

  // ── Codex Task Watcher ─────────────────────────────────────
  //
  // Polls running Codex tasks every 30s. When a task's tmux session terminates,
  // captures output, builds a Codex Completion Protocol wake prompt, and feeds
  // it into runAgent. The agent's response posts to its primary channel as a
  // normal turn — visible to the owner, complete with any tool calls the agent decides
  // to make (review, QA, deploy, refix, or stay silent per its AGENTS.md).
  //
  // Wake message lives in the user-message position — does NOT mutate the
  // system prompt → cache prefix stays warm.

  const DEFAULT_COMPLETION_PROMPT = (
    task: CodexTask,
    output: string,
    diff: string
  ) => {
    return `[Codex task \`${task.taskName}\` ${task.status === "completed" ? "completed" : "ENDED — status: " + task.status}]

Project: ${task.projectDir}
Started: ${task.startedAt}
${task.waveContext ? `Wave context: ${task.waveContext}\n` : ""}
${task.baseSha ? `Base SHA: ${task.baseSha.slice(0, 8)}\n` : ""}
--- Output (last ~100 lines from tmux) ---
${output}

--- Diff summary ---
${diff}

--- Codex Completion Protocol (from your AGENTS.md) ---

1. REVIEW the diff. Quality, edge cases, error handling, missed spec requirements.
   If issues: write a fix spec, call LaunchCodexTask again with it, stay silent.

2. QA the deploy.
   - Vercel/Railway: hit the live URL with curl, verify HTTP 200 + key endpoints work.
   - Migrations: verify schema state.
   - Tests: run them.
   If broken: write fix spec, LaunchCodexTask again, stay silent.

3. ACTION.
   - Clean: ensure on \`main\`, deploy is green. Then post to your channel:
     "Wave done. Live at <url>. <plain-English changelog>. Test as a user, sign off when ready."
   - Wave gate: if \`wave_context\` indicates more waves, STOP after this one is clean.
     Do NOT auto-launch the next wave. Wait for the owner to say go.
   - Nothing actionable: stay silent. Don't post anything.

The owner reads NO code. The owner tests as a user. Your final post must be a user-facing
changelog with a live URL, not a code summary.`;
  };

  async function processCompletedTask(task: CodexTask): Promise<void> {
    // Resolve the primary channel — first one in agent's channels list.
    const primaryChannelName = [...allowedChannels][0];
    if (!primaryChannelName) {
      console.error(`[codex-watcher] No primary channel for ${agentName}, can't post wake`);
      return;
    }
    const channel = client.channels.cache.find(
      (c: any) => c instanceof TextChannel && c.name === primaryChannelName
    ) as TextChannel | undefined;
    if (!channel) {
      console.error(`[codex-watcher] Channel #${primaryChannelName} not in cache; skipping wake`);
      return;
    }

    const output = captureOutput(task.sessionName, 100);
    const diff = getDiffSummary(task.projectDir, task.baseSha, 6000);
    const wakePrompt = (task.onCompletePrompt && task.onCompletePrompt.trim().length > 0)
      ? task.onCompletePrompt
          .replace(/\$OUTPUT/g, output)
          .replace(/\$DIFF/g, diff)
          .replace(/\$TASK_NAME/g, task.taskName)
      : DEFAULT_COMPLETION_PROMPT(task, output, diff);

    console.log(`[codex-watcher] Waking ${agentName} for task ${task.taskId} (${task.taskName})`);

    // Kill the tmux session so it doesn't linger.
    try {
      await new Promise<void>((resolve) => {
        const killChild = require("child_process").spawn("tmux", ["kill-session", "-t", task.sessionName]);
        killChild.on("close", () => resolve());
      });
    } catch {}

    // Run the agent like a normal Discord turn — post output to the channel.
    let resultText = "";
    let lastInterim = "";
    let didSendInterim = false;
    const errors: string[] = [];
    const systemMessages: string[] = [];

    await channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);

    try {
      const result = await runAgent(
        wakePrompt,
        agentConfig,
        (msg: AgentMessage) => {
          switch (msg.type) {
            case "text_interim": {
              if (!runtimeState.showThinking) break;
              if (msg.content.includes("[ATTACH:")) break;
              const trimmed = msg.content.trim();
              if (!trimmed) break;
              lastInterim = msg.content;
              didSendInterim = true;
              const asSubtext = trimmed
                .split("\n")
                .map((line) => (line.trim() ? `-# ${line}` : line))
                .join("\n");
              void sendToChannel(channel, asSubtext).catch((e) =>
                console.error(`[interim-wake] ${e instanceof Error ? e.message : e}`)
              );
              break;
            }
            case "text":
              resultText = msg.content === lastInterim ? "" : msg.content;
              break;
            case "error":
              errors.push(msg.content);
              break;
            case "system":
              systemMessages.push(msg.content);
              break;
            case "tool_use":
              break;
          }
        },
        async () => false,  // wake mode does not handle approvals
        currentSessionId,
      );

      if (result.sessionId) {
        currentSessionId = result.sessionId;
        saveSession(agentName, result.sessionId);
      }
      updateStats(sessionStats, result);
      logUsage(agentName, result, sessionStats.model);
      clearInterval(typingInterval);

      for (const sysMsg of systemMessages) {
        await channel.send(sysMsg).catch(() => {});
      }
      for (const err of errors) {
        await channel.send(err).catch(() => {});
      }

      // Important: if resultText is empty AND no interim was posted, the agent
      // CHOSE to stay silent (per the protocol's "nothing actionable" branch).
      // We do NOT post a fallback message in that case — silence is the signal
      // that no owner action is needed.
      if (resultText.trim() && resultText !== lastInterim) {
        await sendToChannel(channel, resultText).catch((e) =>
          console.error(`[wake-send] ${e instanceof Error ? e.message : e}`)
        );
      } else if (!didSendInterim && errors.length === 0) {
        console.log(`[codex-watcher] Agent chose silence for task ${task.taskId} — no owner notification`);
      }
    } catch (e) {
      clearInterval(typingInterval);
      console.error(`[codex-watcher] runAgent failed for task ${task.taskId}:`, e);
    }
  }

  async function pollCodexTasks(): Promise<void> {
    const running = listTasks({ agent: agentName, status: "running" });
    for (const task of running) {
      if (isSessionAlive(task.sessionName)) continue;  // still working
      // Session terminated — capture before kill
      const output = captureOutput(task.sessionName, 200);
      const failed = /error|exit code [^0]|fatal/i.test(output) && !/0 errors|completed successfully/i.test(output);
      const updated = updateTask(task.taskId, {
        status: failed ? "failed" : "completed",
        completedAt: new Date().toISOString(),
        outputTail: output.slice(-2000),
      });
      if (updated) {
        try {
          await processCompletedTask(updated);
        } catch (e) {
          console.error(`[codex-watcher] processCompletedTask error:`, e);
        }
      }
    }
  }

  // Start the watcher 15s after Discord ready (let other init complete first).
  setTimeout(() => {
    setInterval(() => {
      pollCodexTasks().catch((e) => console.error(`[codex-watcher] poll error:`, e));
    }, 30_000);
    console.log(`[codex-watcher] Polling every 30s for tasks owned by ${agentName}`);
  }, 15_000);

  // Hivemind outbox poller — bridges out-of-process tools (claude-cli runtime's
  // stdio MCP server) to the Discord client (which only the bot process has).
  // The stdio MCP SendMessage handler writes to data/hivemind-outbox/*.json.
  // The poller runs in ONE designated bot because:
  //   1. only CLI-runtime agents produce outbox messages
  //   2. The relay bot must NOT be the recipient — otherwise the
  //      `message.author.id === client.user?.id` self-check below rejects the
  //      relayed message and the recipient never processes it.
  // When more agents migrate to CLI runtime, each runs their own poller (with
  // an atomic-rename claim to avoid multi-drainer races — TODO).
  if ((agentDef as Record<string, unknown>).hivemind_outbox_poller === true) {
    const { drainOutbox } = await import("../tools/hivemind-outbox.js");
    const { sendToAgent } = await import("../tools/messaging.js");
    setTimeout(() => {
      setInterval(async () => {
        try {
          const messages = drainOutbox();
          for (const msg of messages) {
            const result = await sendToAgent(msg.from, msg.to, msg.message);
            if (!result.success) {
              console.error(`[outbox-poller] Failed to deliver ${msg.id}: ${result.error}`);
            } else {
              console.log(`[outbox-poller] Delivered ${msg.id} (${msg.from} → ${msg.to})`);
            }
          }
        } catch (e) { console.error(`[outbox-poller] error:`, e); }
      }, 2_000);
      console.log(`[outbox-poller] Draining hivemind outbox every 2s`);
    }, 15_000);
  }

  // Hivemind message routing pattern: **[from -> to]**
  const HIVEMIND_PATTERN = /^\*\*\[(\S+)\s*→\s*(\S+)\]\*\*\n([\s\S]*)$/;
  const HIVEMIND_CHANNEL = "hivemind";

  client.on("messageCreate", async (message: Message) => {
    // Get channel name
    const channelName =
      message.channel instanceof TextChannel
        ? message.channel.name
        : message.channel instanceof ThreadChannel
          ? message.channel.parent?.name || "unknown"
          : "dm";

    // ── Hivemind: inter-agent messages ──
    if (channelName === HIVEMIND_CHANNEL && message.author.bot) {
      const match = message.content.match(HIVEMIND_PATTERN);
      if (!match) return;

      const [, fromAgent, toAgent, body] = match;
      if (toAgent !== agentName) return;
      if (message.author.id === client.user?.id) return;

      const isResponse = isHivemindResponsePending(fromAgent);
      if (isResponse) {
        console.log(`[hivemind] Response from ${fromAgent} (absorbing, no reply to #hivemind)`);
      } else {
        console.log(`[hivemind] Request from ${fromAgent} → ${agentName}`);
      }

      const taggedPrompt = `[Message from ${fromAgent} via #hivemind — reply directly, do NOT use SendMessage]\n${body.trim()}`;

      const channel = message.channel as TextChannel;
      channel.sendTyping().catch(() => {});
      const typingInterval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);

      let resultText = "";
      const errors: string[] = [];

      setHivemindProcessing(true);

      try {
        const result = await runAgent(
          taggedPrompt,
          agentConfig,
          (msg: AgentMessage) => {
            switch (msg.type) {
              case "text": resultText = msg.content; break;
              case "error": errors.push(msg.content); break;
            }
          },
          async () => false,
          currentSessionId,
        );

        if (result.sessionId) {
          currentSessionId = result.sessionId;
          saveSession(agentName, result.sessionId);
        }
        updateStats(sessionStats, result);
        logUsage(agentName, result, sessionStats.model);

        clearInterval(typingInterval);

        if (!isResponse) {
          if (resultText.trim()) {
            // Loop guard 1: [NO_REPLY] marker — agent opted out of relay.
            if (isNoReply(resultText)) {
              console.log(`[hivemind] ${agentName} → ${fromAgent}: NO_REPLY marker — skipping relay`);
            }
            // Loop guard 2: per-direction circuit breaker. If 5+ relays in 60s
            // window for this (from→to) pair, suppress to break runaway loops.
            else if (relayLoopGuardTripped(agentName, fromAgent)) {
              console.warn(`[hivemind] ${agentName} → ${fromAgent}: relay loop guard tripped (>5 relays/60s) — suppressing`);
            }
            else {
              const { cleanText } = extractAttachments(resultText);
              const responseFormatted = `**[${agentName} → ${fromAgent}]**\n${cleanText}`;
              const chunks = splitMessage(responseFormatted);
              for (const chunk of chunks) {
                await channel.send(chunk);
              }
            }
          }

          for (const err of errors) {
            await channel.send(`**[${agentName} → ${fromAgent}]**\n❌ ${err}`);
          }
        } else {
          console.log(`[hivemind] Absorbed response from ${fromAgent} into session (no hivemind reply)`);
          if (resultText.trim()) {
            const ownChannelName = [...allowedChannels][0];
            const ownChannel = client.channels.cache.find(
              (ch) => ch instanceof TextChannel && ch.name === ownChannelName
            ) as TextChannel | undefined;
            if (ownChannel) {
              const { cleanText, filePaths } = extractAttachments(resultText);
              const discordFiles: AttachmentBuilder[] = [];
              for (const fp of filePaths) {
                try {
                  if (existsSync(fp)) {
                    discordFiles.push(new AttachmentBuilder(fp, { name: basename(fp) }));
                  }
                } catch {}
              }
              await sendToChannel(ownChannel, cleanText || resultText, discordFiles);
            }
          }
        }
      } catch (error) {
        clearInterval(typingInterval);
        const errMsg = error instanceof Error ? error.message : String(error);
        await channel.send(`**[${agentName} → ${fromAgent}]**\n❌ Error: ${errMsg}`);
      } finally {
        setHivemindProcessing(false);
      }

      return;
    }

    // ── Normal messages: owner only, OR whitelisted webhook ingress ──

    const isAllowedWebhook =
      message.webhookId !== null &&
      message.webhookId !== undefined &&
      agentConfig.webhookIngress.allowedIds.includes(message.webhookId);

    if (message.author.bot && !isAllowedWebhook) return;
    if (!message.author.bot && message.author.id !== ownerId) return;
    if (isAllowedWebhook) {
      console.log(`[webhook-ingress] Accepting message from webhook ${message.webhookId}`);
    }

    // Check for approval responses
    const content = message.content.trim().toLowerCase();
    if (content === "yes" || content === "no") {
      for (const [id, pending] of pendingApprovals) {
        clearTimeout(pending.timeout);
        pending.resolve(content === "yes");
        pendingApprovals.delete(id);
        return;
      }
    }

    if (!allowedChannels.has(channelName)) return;

    // Show typing indicator. Fire-and-forget — a degraded Discord typing
    // endpoint (e.g. post-outage 429s, scope=shared) must never block the
    // message handler. We swallow errors silently; visible-typing is purely
    // cosmetic and not worth logspam during shared rate-limit windows.
    const channel = message.channel as TextChannel | ThreadChannel;
    channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);

    // Extract image attachments
    const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    const imageAttachments: ImageAttachment[] = [];
    const fileDescriptions: string[] = [];

    for (const [, attachment] of message.attachments) {
      const contentType = attachment.contentType || "";
      if (IMAGE_TYPES.has(contentType) && attachment.url) {
        imageAttachments.push({
          url: attachment.url,
          mediaType: contentType as ImageAttachment["mediaType"],
        });
      } else if (attachment.url && attachment.name) {
        try {
          const localPath = await downloadAttachment(attachment.url, attachment.name);
          fileDescriptions.push(`[Attached file: ${attachment.name} → saved to ${localPath}]`);
          console.log(`[files] Downloaded ${attachment.name} → ${localPath}`);
        } catch (err) {
          console.error(`[files] Failed to download ${attachment.name}:`, err);
          fileDescriptions.push(`[Attached file: ${attachment.name} — download failed]`);
        }
      }
    }

    if (imageAttachments.length > 0) {
      console.log(`[images] ${imageAttachments.length} image(s) attached`);
    }

    let userPrompt = message.content;
    if (fileDescriptions.length > 0) {
      userPrompt = fileDescriptions.join("\n") + "\n\n" + userPrompt;
    }

    // Track responses
    let resultText = "";
    let lastInterim = "";
    let didSendInterim = false;
    const errors: string[] = [];
    const systemMessages: string[] = [];

    try {
      const result = await runAgent(
        userPrompt,
        agentConfig,
        (msg: AgentMessage) => {
          switch (msg.type) {
            case "text_interim": {
              // Gated on the per-agent /show-thinking toggle. Default off.
              if (!runtimeState.showThinking) break;
              // Attachment markers belong in the final reply so extractAttachments()
              // can process them there. If an interim happens to contain one, skip.
              if (msg.content.includes("[ATTACH:")) break;
              const trimmed = msg.content.trim();
              if (!trimmed) break;
              lastInterim = msg.content;
              didSendInterim = true;
              // Prefix each non-empty line with "-# " so Discord renders as subtext.
              const asSubtext = trimmed
                .split("\n")
                .map((line) => (line.trim() ? `-# ${line}` : line))
                .join("\n");
              void sendToChannel(channel, asSubtext).catch((e) =>
                console.error(`[interim] ${e instanceof Error ? e.message : e}`)
              );
              break;
            }
            case "text":
              // Dedup: if the final exactly matches the last posted interim,
              // the user already saw it — skip re-sending as the main reply.
              resultText = msg.content === lastInterim ? "" : msg.content;
              break;
            case "error":
              errors.push(msg.content);
              break;
            case "system":
              systemMessages.push(msg.content);
              break;
            case "tool_use":
              break;
          }
        },
        async (approvalMessage: string) => {
          const approvalMsg = await channel.send(
            `⚠️ **Approval Required**\n${approvalMessage}\n\nReply **yes** or **no**.`
          );

          return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              pendingApprovals.delete(approvalMsg.id);
              resolve(false);
              channel.send("⏰ Approval timed out — action denied.");
            }, 120_000);

            pendingApprovals.set(approvalMsg.id, { resolve, timeout });
          });
        },
        currentSessionId,
        imageAttachments.length > 0 ? imageAttachments : undefined
      );

      if (result.sessionId) {
        currentSessionId = result.sessionId;
        saveSession(agentName, result.sessionId);
      }
      updateStats(sessionStats, result);
      logUsage(agentName, result, sessionStats.model);

      clearInterval(typingInterval);

      for (const sysMsg of systemMessages) {
        await channel.send(sysMsg);
      }

      for (const err of errors) {
        await channel.send(err);
      }

      if (!resultText.trim()) {
        // If the final text was deduped against an interim we already posted,
        // the user already saw content — don't post a "no output" placeholder.
        if (errors.length === 0 && !didSendInterim) {
          await channel.send("*(completed with no text output)*");
        }
        return;
      }

      // Extract file attachments from agent response
      const { cleanText, filePaths } = extractAttachments(resultText);
      const discordFiles: AttachmentBuilder[] = [];

      for (const filePath of filePaths) {
        try {
          if (existsSync(filePath)) {
            discordFiles.push(new AttachmentBuilder(filePath, { name: basename(filePath) }));
            console.log(`[files] Attaching ${filePath}`);
          } else {
            console.error(`[files] File not found: ${filePath}`);
          }
        } catch (err) {
          console.error(`[files] Failed to attach ${filePath}:`, err);
        }
      }

      await sendToChannel(channel, cleanText || resultText, discordFiles);

      // If there's no text but there are files, send files alone
      if (!cleanText.trim() && discordFiles.length > 0) {
        await channel.send({ files: discordFiles });
      }
    } catch (error) {
      clearInterval(typingInterval);
      const errMsg = error instanceof Error ? error.message : String(error);
      await channel.send(`❌ Error: ${errMsg}`);
    }
  });

  // ── Cron agent executor ──
  setAgentExecutor(async (prompt: string) => {
    const taggedPrompt = `[Scheduled task — cron job]\n${prompt}`;

    let resultText = "";
    const errors: string[] = [];

    try {
      const result = await runAgent(
        taggedPrompt,
        agentConfig,
        (msg: AgentMessage) => {
          switch (msg.type) {
            case "text": resultText = msg.content; break;
            case "error": errors.push(msg.content); break;
          }
        },
        async () => false,
        currentSessionId,
      );

      if (result.sessionId) {
        currentSessionId = result.sessionId;
        saveSession(agentName, result.sessionId);
      }
      updateStats(sessionStats, result);
      logUsage(agentName, result, sessionStats.model);

      // Send result to the agent's own Discord channel
      if (client.isReady()) {
        const ownChannelName = [...allowedChannels][0];
        const ownChannel = client.channels.cache.find(
          (ch) => ch instanceof TextChannel && ch.name === ownChannelName
        ) as TextChannel | undefined;

        if (ownChannel) {
          const fullOutput = [...errors.map(e => `❌ ${e}`), resultText].filter(Boolean).join("\n");
          if (fullOutput.trim()) {
            const { cleanText, filePaths } = extractAttachments(fullOutput);
            const discordFiles: AttachmentBuilder[] = [];
            for (const fp of filePaths) {
              try {
                if (existsSync(fp)) {
                  discordFiles.push(new AttachmentBuilder(fp, { name: basename(fp) }));
                }
              } catch {}
            }
            await sendToChannel(ownChannel, cleanText || fullOutput, discordFiles);
          }
        }
      }

      return resultText;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[cron] Agent executor failed: ${errMsg}`);
      return `Error: ${errMsg}`;
    }
  });

  await client.login(token);
  return client;
}
