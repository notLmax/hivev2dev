/**
 * transcript-store.ts — per-session conversation persistence for the
 * anthropic-compat lane. JSONL, one message per line, at
 * <behaviorDir>/session-compat/<sessionId>.jsonl (precedent: the ADK lane's
 * session-adk.sqlite lives in behaviorDir; JSONL over SQLite = no native dep,
 * greppable, trivially portable).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { Msg, MsgBlock } from "./normalizer.js";

function sessionDir(behaviorDir: string): string {
  return join(behaviorDir, "session-compat");
}

function sessionFile(behaviorDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(sessionDir(behaviorDir), `${safe}.jsonl`);
}

export function newSessionId(): string {
  return "compat-" + randomBytes(6).toString("hex");
}

/** Returns the transcript, or null when the session file doesn't exist / is unreadable. */
export function loadTranscript(behaviorDir: string, sessionId: string): Msg[] | null {
  const file = sessionFile(behaviorDir, sessionId);
  if (!existsSync(file)) return null;
  try {
    const messages: Msg[] = [];
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      messages.push(JSON.parse(trimmed) as Msg);
    }
    return messages;
  } catch (err) {
    console.error(`[compat] Failed to load transcript ${sessionId}:`, err);
    return null;
  }
}

export function saveTranscript(behaviorDir: string, sessionId: string, messages: Msg[]): void {
  try {
    mkdirSync(sessionDir(behaviorDir), { recursive: true });
    const body = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    writeFileSync(sessionFile(behaviorDir, sessionId), body, "utf-8");
  } catch (err) {
    console.error(`[compat] Failed to save transcript ${sessionId}:`, err);
  }
}

/**
 * Post-turn image surgery (the 280k-token replay lesson, 02 §C.4): the model
 * sees an image on the turn it arrives; afterwards it becomes a placeholder
 * so it is never re-billed.
 */
export function stripImages(messages: Msg[]): Msg[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const content: MsgBlock[] = m.content.map((b) =>
      b.type === "image" ? { type: "text", text: "[image processed - data stripped post-turn]" } : b
    );
    return { ...m, content };
  });
}
