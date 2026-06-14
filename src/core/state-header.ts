/**
 * state-header.ts — the per-message "Session State" header (Queen Bee 04 §4.2).
 *
 * Mutable agent state (daily memories; later: TASKS/MEMORY/LESSONS/OUTPUT-LOG
 * and recent codex tasks) is rendered here and prepended to the LATEST user
 * message instead of living in the system prompt. The system prompt stays
 * deterministic across turns, so mid-session state writes never invalidate the
 * cached prefix — only the new user message is uncached, which it would be
 * anyway. (Measured on this lineage: 88% cache hit on memory-write turns vs
 * 5–20% with daily memory in the prompt.)
 *
 * The header is prepended centrally in runAgent() (src/core/agent.ts), BEFORE
 * runtime dispatch — so every entry point (Discord message, hivemind inbound,
 * codex wake, cron) and every runtime (claude-agent-sdk, google-adk, future)
 * carries identical state. This also doubles as degraded session resume: when
 * an SDK session is lost, the fresh session's first message still carries the
 * agent's full mutable state — we lose conversation, not state.
 *
 * Old copies of the header accumulate in conversation history (cached at the
 * 0.1x read rate); the supersession line in the title tells the model to trust
 * the newest copy. Per-section tail-truncation bounds the per-message cost —
 * headerChars telemetry (data/usage.jsonl) tracks it.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { listTasks as codexListTasks } from "../tools/codex-tasks.js";

/**
 * Resolved state-header configuration (from the additive `state_header:`
 * config block; absent block = these defaults). Each include flag drives BOTH
 * the file's eviction from the system prompt AND its header section — a
 * single switch, so the two sides can never disagree. Rollback for any file
 * is one flag + restart.
 */
export interface StateHeaderConfig {
  dailyMemoryDays: number;
  maxSectionChars: number;
  includeMemory: boolean;
  includeTasks: boolean;
  includeLessons: boolean;
  includeOutputLog: boolean;
  includeCodexTasks: boolean;
  codexTasksLimit: number;
}

export const DEFAULT_STATE_HEADER_CONFIG: StateHeaderConfig = {
  dailyMemoryDays: 2,
  maxSectionChars: 8000,
  includeMemory: true,
  includeTasks: true,
  includeLessons: true,
  includeOutputLog: true,
  includeCodexTasks: true,
  codexTasksLimit: 5,
};

/**
 * Parses the snake_case `state_header:` yaml block (global, with optional
 * per-agent overlay). Unknown/absent keys fall back to defaults — additive,
 * behavior-preserving.
 */
export function parseStateHeaderConfig(
  globalBlock?: Record<string, unknown>,
  agentBlock?: Record<string, unknown>
): StateHeaderConfig {
  const d = DEFAULT_STATE_HEADER_CONFIG;
  const pick = (key: string): unknown => agentBlock?.[key] ?? globalBlock?.[key];
  const num = (key: string, dflt: number): number => {
    const v = pick(key);
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  const bool = (key: string, dflt: boolean): boolean => {
    const v = pick(key);
    return typeof v === "boolean" ? v : dflt;
  };
  return {
    dailyMemoryDays: num("daily_memory_days", d.dailyMemoryDays),
    maxSectionChars: num("max_section_chars", d.maxSectionChars),
    includeMemory: bool("include_memory", d.includeMemory),
    includeTasks: bool("include_tasks", d.includeTasks),
    includeLessons: bool("include_lessons", d.includeLessons),
    includeOutputLog: bool("include_output_log", d.includeOutputLog),
    includeCodexTasks: bool("include_codex_tasks", d.includeCodexTasks),
    codexTasksLimit: num("codex_tasks_limit", d.codexTasksLimit),
  };
}

/**
 * The behavior files this config evicts from the system prompt (and renders
 * here instead). Used by BOTH prompt assembly and header assembly — the
 * single source of truth that keeps them consistent across all runtimes.
 */
export function evictedBehaviorFiles(cfg: StateHeaderConfig): string[] {
  return [
    ...(cfg.includeMemory ? ["MEMORY.md"] : []),
    ...(cfg.includeTasks ? ["TASKS.md"] : []),
    ...(cfg.includeLessons ? ["LESSONS.md"] : []),
    ...(cfg.includeOutputLog ? ["OUTPUT-LOG.md"] : []),
  ];
}

/** Minimal codex-task shape the header needs (injectable for tests). */
export interface CodexTaskSummary {
  taskId: string;
  taskName: string;
  status: string;
  startedAt: string;
}

export interface StateHeaderOptions {
  /** Agent's daily-memory directory (agents/<name>/memory). */
  memoryDir?: string;
  /** Agent's behavior dir — required for behaviorFiles sections. */
  behaviorDir?: string;
  /** Agent name — required for the codex-tasks section. */
  agentName?: string;
  /** How many trailing day-files to include. Default 2. */
  dailyMemoryDays?: number;
  /** Per-section size cap; sections keep their TAIL (newest content). Default 8000. */
  maxSectionChars?: number;
  /**
   * Behavior files evicted from the system prompt, rendered as live sections
   * here (e.g. ["MEMORY.md", "TASKS.md"]). Order is preserved.
   */
  behaviorFiles?: string[];
  includeCodexTasks?: boolean;
  codexTasksLimit?: number;
  /** Injectable for tests; defaults to the codex-tasks registry on disk. */
  codexTasksProvider?: (agent: string) => CodexTaskSummary[];
}

const DEFAULT_DAILY_MEMORY_DAYS = DEFAULT_STATE_HEADER_CONFIG.dailyMemoryDays;
const DEFAULT_MAX_SECTION_CHARS = DEFAULT_STATE_HEADER_CONFIG.maxSectionChars;

function readFileTrimmed(filepath: string): string {
  if (!existsSync(filepath)) return "";
  try {
    return readFileSync(filepath, "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Returns the last `days` daily-memory files (YYYY-MM-DD.md) as rendered
 * blocks, oldest first. (Moved from prompt-builder.ts — daily memories left
 * the system prompt on 2026-05-02.)
 */
export function getRecentMemories(memoryDir: string, days: number = DEFAULT_DAILY_MEMORY_DAYS): string[] {
  if (!existsSync(memoryDir)) return [];
  const files = readdirSync(memoryDir)
    .filter((f: string) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .slice(0, days)
    .reverse();
  const memories: string[] = [];
  for (const file of files) {
    const content = readFileTrimmed(join(memoryDir, file));
    if (content) memories.push("### " + file + "\n\n" + content);
  }
  return memories;
}

/**
 * Caps a section's size, keeping the TAIL — for log-like files (daily memory,
 * OUTPUT-LOG) the newest content is at the bottom and matters most.
 */
export function tailTruncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const cut = content.length - maxChars;
  return `[... ${cut} chars truncated — full content on disk ...]\n` + content.slice(cut);
}

function defaultCodexTasksProvider(agent: string): CodexTaskSummary[] {
  // Cheap JSON read of data/codex-tasks.json via the registry.
  return codexListTasks({ agent });
}

/**
 * Builds the Session State header to prepend to the latest user message.
 * Returns "" when there is no state to render.
 */
export function buildStateHeader(opts: StateHeaderOptions): string {
  const maxSectionChars = opts.maxSectionChars ?? DEFAULT_MAX_SECTION_CHARS;
  const sections: string[] = [];

  // Recent daily memories (2-day window; shifts at midnight — cache-safe here).
  if (opts.memoryDir) {
    const memories = getRecentMemories(opts.memoryDir, opts.dailyMemoryDays ?? DEFAULT_DAILY_MEMORY_DAYS);
    if (memories.length > 0) {
      sections.push(tailTruncate("## Recent Daily Memories\n\n" + memories.join("\n\n"), maxSectionChars));
    }
  }

  // Mutable behavior files evicted from the system prompt (04 §4.1–4.2).
  // The label tells the agent these are the live contents — behavior files
  // that say "TASKS.md is in your context" keep being true.
  if (opts.behaviorDir) {
    for (const file of opts.behaviorFiles ?? []) {
      const content = readFileTrimmed(join(opts.behaviorDir, file));
      if (content) {
        sections.push(
          tailTruncate(`## ${file} (live contents — not in your system prompt)\n\n` + content, maxSectionChars)
        );
      }
    }
  }

  // Recent codex tasks — replaces any need to poll the registry for status.
  if (opts.includeCodexTasks && opts.agentName) {
    try {
      const provider = opts.codexTasksProvider ?? defaultCodexTasksProvider;
      const limit = opts.codexTasksLimit ?? DEFAULT_STATE_HEADER_CONFIG.codexTasksLimit;
      const tasks = provider(opts.agentName)
        .slice()
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, limit);
      if (tasks.length > 0) {
        const rows = tasks.map((t) => `| ${t.taskId} | ${t.taskName} | ${t.status} | ${t.startedAt} |`);
        sections.push(
          "## Recent Codex Tasks\n\n| task | name | status | started |\n|------|------|--------|---------|\n" +
            rows.join("\n")
        );
      }
    } catch (err) {
      // State header must never kill a turn — skip the section.
      console.error("[state-header] codex-tasks section failed:", err);
    }
  }

  if (sections.length === 0) return "";

  return (
    "# Session State\n\n" +
    "Auto-injected with this message. This is the LIVE copy — it supersedes any older Session State or Recent Daily Memories blocks earlier in this conversation.\n\n" +
    sections.join("\n\n") +
    "\n\n---\n\n"
  );
}
