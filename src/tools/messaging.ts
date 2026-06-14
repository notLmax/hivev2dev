/**
 * messaging.ts
 * Send messages to Discord channels programmatically.
 * Inter-agent messages route through #hivemind with [from → to] format.
 */

import { Client, TextChannel } from "discord.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

let discordClient: Client | null = null;
const HIVEMIND_CHANNEL = "hivemind";

// ── Large-message auto-offload ────────────────────────────────
// Discord rejects messages over 2000 chars with a 400, which silently dropped
// big inter-agent hand-offs. When a hivemind body exceeds the threshold we
// write the full content to shared/exchange/ and send a short stub that tells
// the recipient to Read the file (the Read tool isn't path-gated). No bot-side
// attachment resolution needed.
export const HIVEMIND_OFFLOAD_THRESHOLD = 1900;

function exchangeDir(): string {
  return process.env.HIVE_EXCHANGE_DIR || join(process.cwd(), "shared", "exchange");
}

function deriveSlug(message: string): string {
  const firstLine = message.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "message";
  const slug = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "message";
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Returns the message to actually send over hivemind. If `message` exceeds the
 * Discord-safe threshold, writes it to shared/exchange/ and returns a short
 * pointer stub instead; otherwise returns `message` unchanged. Never throws —
 * on write failure it truncates inline rather than dropping the whole message.
 */
export function maybeOffloadHivemind(from: string, to: string, message: string): string {
  if (message.length <= HIVEMIND_OFFLOAD_THRESHOLD) return message;
  try {
    const dir = exchangeDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${from}-${to}-${deriveSlug(message)}-${stamp(new Date())}.md`);
    writeFileSync(file, `# ${from} → ${to}\n\n${message}\n`);
    return (
      `[Large message — ${message.length} chars — offloaded to a file]\n` +
      `Full content: ${file}\n` +
      `Read that file with your Read tool before responding.`
    );
  } catch (err) {
    console.error(`[hivemind] offload failed, truncating inline:`, err);
    return message.slice(0, HIVEMIND_OFFLOAD_THRESHOLD) + "\n…[truncated; offload failed]";
  }
}

/**
 * Tracks agents we've sent hivemind messages TO, with timestamps.
 * When a response comes back from one of these agents within the window,
 * the hivemind handler absorbs it silently (no auto-reply to #hivemind)
 * to prevent infinite loops and unnecessary chatter.
 *
 * Uses a Map<agentName, timestamp>.
 *
 * Persistence: snapshotted to agents/<name>/state/delegations.json on every
 * set(). Loaded once at bot startup via initDelegationRegistry(). Survives
 * PM2 restart so a delegation in flight when the agent crashes/restarts
 * doesn't get dropped.
 *
 * TTL extended from 5 min → 24 hours so long-running multi-agent work
 * (e.g. waiting on a Codex task that itself does a hivemind delegation)
 * doesn't time out mid-flight.
 */
const HIVEMIND_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const pendingHivemindTargets = new Map<string, number>();

let registryAgentName: string | null = null;

function delegationFilePath(agentName: string): string {
  return join(process.cwd(), "agents", agentName, "state", "delegations.json");
}

/**
 * Load the persisted delegation registry from disk into the in-memory Map.
 * Called once at bot startup (via initDelegationRegistry below). After this,
 * pendingHivemindTargets contains any delegations that were in flight when
 * the bot last shut down (subject to TTL).
 */
export function initDelegationRegistry(agentName: string): void {
  registryAgentName = agentName;
  try {
    const path = delegationFilePath(agentName);
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    let restored = 0;
    for (const [target, sentAt] of Object.entries(data)) {
      if (now - sentAt < HIVEMIND_RESPONSE_WINDOW_MS) {
        pendingHivemindTargets.set(target, sentAt);
        restored++;
      }
    }
    if (restored > 0) {
      console.log(`[hivemind] Restored ${restored} pending delegation(s) from disk`);
    }
  } catch (err) {
    console.error(`[hivemind] Failed to load delegation registry:`, err);
  }
}

function persistDelegations(): void {
  if (!registryAgentName) return;  // Not initialized yet — skip.
  try {
    const path = delegationFilePath(registryAgentName);
    mkdirSync(dirname(path), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [k, v] of pendingHivemindTargets.entries()) {
      obj[k] = v;
    }
    writeFileSync(path, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error(`[hivemind] Failed to persist delegation registry:`, err);
  }
}

/**
 * When true, the agent is processing a hivemind message.
 * SendMessage calls are blocked — the bot code handles response routing.
 * This prevents double-posting and poisoned pendingHivemindTargets state.
 */
export let hivemindProcessingActive = false;

export function setHivemindProcessing(active: boolean): void {
  hivemindProcessingActive = active;
}

/**
 * Checks if an agent is within the pending response window.
 */
export function isHivemindResponsePending(agentName: string): boolean {
  const sentAt = pendingHivemindTargets.get(agentName);
  if (!sentAt) return false;
  if (Date.now() - sentAt > HIVEMIND_RESPONSE_WINDOW_MS) {
    pendingHivemindTargets.delete(agentName);
    persistDelegations();
    return false;
  }
  return true;
}

/**
 * Registers the Discord client for use by the messaging tool.
 * Called once at startup after the bot connects.
 */
export function registerDiscordClient(client: Client): void {
  discordClient = client;
}

/**
 * Sends a message to another agent via the #hivemind channel.
 * Messages are formatted as [from → to] for routing.
 */
export async function sendToAgent(
  from: string,
  to: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  if (!discordClient) {
    return { success: false, error: "Discord client not initialized" };
  }

  const hivemind = discordClient.channels.cache.find(
    (ch) => ch instanceof TextChannel && ch.name === HIVEMIND_CHANNEL
  ) as TextChannel | undefined;

  if (!hivemind) {
    return { success: false, error: `#${HIVEMIND_CHANNEL} channel not found. Create it in Discord.` };
  }

  try {
    const body = maybeOffloadHivemind(from, to, message);
    const formatted = `**[${from} → ${to}]**\n${body}`;
    await hivemind.send(formatted);
    pendingHivemindTargets.set(to, Date.now());
    persistDelegations();
    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

/**
 * Sends a message to a Discord channel by name.
 * Used for direct channel posting (non-hivemind).
 */
export async function sendToChannel(
  channelName: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  if (!discordClient) {
    return { success: false, error: "Discord client not initialized" };
  }

  const channel = discordClient.channels.cache.find(
    (ch) => ch instanceof TextChannel && ch.name === channelName
  ) as TextChannel | undefined;

  if (!channel) {
    return { success: false, error: `Channel "${channelName}" not found` };
  }

  try {
    await channel.send(message);
    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

/**
 * Sends a message to a Discord channel by ID.
 */
export async function sendToChannelById(
  channelId: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  if (!discordClient) {
    return { success: false, error: "Discord client not initialized" };
  }

  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      return { success: false, error: `Channel ${channelId} not found or not a text channel` };
    }

    await channel.send(message);
    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}
