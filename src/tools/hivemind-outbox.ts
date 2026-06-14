/**
 * hivemind-outbox.ts - minimal reimplementation of an uncommitted module.
 *
 * The original was never committed (it shipped alongside the claude-cli POC
 * on the original maintainer's machine). The producer (the claude-cli
 * runtime's stdio MCP SendMessage handler, also uncommitted) writes one JSON
 * file per message to data/hivemind-outbox/. The bot-side poller
 * (src/discord/bot.ts, config-gated) drains them every 2s and relays via
 * sendToAgent(), because only the bot process holds the Discord client.
 *
 * On installs with no producer the directory never exists and drainOutbox()
 * returns [] - this module is then dead code that merely keeps tsc green.
 */

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

export interface OutboxMessage {
  id: string;
  from: string;
  to: string;
  message: string;
}

const OUTBOX_DIR = join(process.cwd(), "data", "hivemind-outbox");

export function drainOutbox(): OutboxMessage[] {
  if (!existsSync(OUTBOX_DIR)) return [];
  const messages: OutboxMessage[] = [];
  const files = readdirSync(OUTBOX_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const path = join(OUTBOX_DIR, file);
    const claimed = path + ".claimed";
    try {
      renameSync(path, claimed); // atomic claim - losers skip
    } catch {
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(claimed, "utf-8")) as Partial<OutboxMessage>;
      if (raw.from && raw.to && raw.message) {
        messages.push({
          id: raw.id ?? file.replace(/\.json$/, ""),
          from: raw.from,
          to: raw.to,
          message: raw.message,
        });
      } else {
        console.error("[outbox] Dropping malformed outbox file: " + file);
      }
    } catch (e) {
      console.error("[outbox] Failed to process " + file + ":", e);
    } finally {
      try {
        unlinkSync(claimed);
      } catch {}
    }
  }
  return messages;
}