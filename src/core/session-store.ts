/**
 * session-store.ts
 * Persists session metadata so conversations can be resumed.
 * The Agent SDK handles actual conversation state internally —
 * this tracks which Discord channel maps to which session.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

interface SessionRecord {
  channelId: string;
  agentName: string;
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}

const STORE_DIR = "./data/sessions";
const STORE_FILE = `${STORE_DIR}/sessions.json`;

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

function load(): SessionRecord[] {
  ensureDir();
  if (!existsSync(STORE_FILE)) return [];
  return JSON.parse(readFileSync(STORE_FILE, "utf-8"));
}

function save(records: SessionRecord[]): void {
  ensureDir();
  writeFileSync(STORE_FILE, JSON.stringify(records, null, 2));
}

/**
 * Gets or creates a session for a Discord channel.
 */
export function getSession(channelId: string, agentName: string): SessionRecord {
  const records = load();
  let record = records.find((r) => r.channelId === channelId && r.agentName === agentName);

  if (!record) {
    record = {
      channelId,
      agentName,
      sessionId: `session-${Date.now()}-${channelId}`,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 0,
    };
    records.push(record);
    save(records);
  }

  return record;
}

/**
 * Updates session activity timestamp and message count.
 */
export function touchSession(channelId: string, agentName: string): void {
  const records = load();
  const record = records.find((r) => r.channelId === channelId && r.agentName === agentName);

  if (record) {
    record.lastActiveAt = new Date().toISOString();
    record.messageCount++;
    save(records);
  }
}

/**
 * Lists all sessions.
 */
export function listSessions(): SessionRecord[] {
  return load();
}

/**
 * Resets a session — forces a fresh conversation on next message.
 */
export function resetSession(channelId: string, agentName: string): boolean {
  const records = load();
  const idx = records.findIndex((r) => r.channelId === channelId && r.agentName === agentName);

  if (idx === -1) return false;

  records.splice(idx, 1);
  save(records);
  return true;
}
