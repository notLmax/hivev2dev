/**
 * Session State header unit tests (Queen Bee 04 §4.2).
 * Fixtures in os.tmpdir() — never agents/*.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildStateHeader,
  getRecentMemories,
  tailTruncate,
  parseStateHeaderConfig,
  evictedBehaviorFiles,
  DEFAULT_STATE_HEADER_CONFIG,
  type CodexTaskSummary,
} from "../src/core/state-header.js";

let root: string;
let behaviorDir: string;
let memoryDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hive-state-header-"));
  behaviorDir = join(root, "agents", "test-agent");
  memoryDir = join(behaviorDir, "memory");
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildStateHeader", () => {
  it("returns empty string when there is no state", () => {
    expect(buildStateHeader({ memoryDir, behaviorDir })).toBe("");
  });

  it("renders the daily-memory window (last N, oldest first)", () => {
    writeFileSync(join(memoryDir, "2026-06-07.md"), "- day 7");
    writeFileSync(join(memoryDir, "2026-06-08.md"), "- day 8");
    writeFileSync(join(memoryDir, "2026-06-09.md"), "- day 9");

    const header = buildStateHeader({ memoryDir, dailyMemoryDays: 2 });
    expect(header).not.toContain("day 7");
    expect(header).toContain("day 8");
    expect(header).toContain("day 9");
    expect(header.indexOf("day 8")).toBeLessThan(header.indexOf("day 9"));
    expect(header).toContain("# Session State");
    expect(header).toContain("supersedes");
    expect(header.endsWith("---\n\n")).toBe(true);
  });

  it("renders evicted behavior files as live sections", () => {
    writeFileSync(join(behaviorDir, "TASKS.md"), "- [ ] live task");
    const header = buildStateHeader({ behaviorDir, behaviorFiles: ["TASKS.md", "MEMORY.md"] });
    expect(header).toContain("## TASKS.md (live contents — not in your system prompt)");
    expect(header).toContain("live task");
    expect(header).not.toContain("## MEMORY.md"); // absent file → no section
  });

  it("tail-truncates oversized sections, keeping the newest content", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `- entry ${i}`).join("\n");
    writeFileSync(join(behaviorDir, "OUTPUT-LOG.md"), lines);
    const header = buildStateHeader({
      behaviorDir,
      behaviorFiles: ["OUTPUT-LOG.md"],
      maxSectionChars: 500,
    });
    expect(header).toContain("chars truncated — full content on disk");
    expect(header).toContain("entry 499"); // tail survives
    expect(header).not.toContain("- entry 0\n"); // head dropped
  });

  it("renders recent codex tasks via injected provider: sorted desc, limited", () => {
    const tasks: CodexTaskSummary[] = [
      { taskId: "task-1", taskName: "oldest", status: "completed", startedAt: "2026-06-01T00:00:00Z" },
      { taskId: "task-2", taskName: "newer", status: "running", startedAt: "2026-06-09T00:00:00Z" },
      { taskId: "task-3", taskName: "newest", status: "running", startedAt: "2026-06-10T00:00:00Z" },
    ];
    const header = buildStateHeader({
      agentName: "test-agent",
      includeCodexTasks: true,
      codexTasksLimit: 2,
      codexTasksProvider: () => tasks,
    });
    expect(header).toContain("## Recent Codex Tasks");
    expect(header).toContain("task-3");
    expect(header).toContain("task-2");
    expect(header).not.toContain("task-1"); // beyond limit
    expect(header.indexOf("task-3")).toBeLessThan(header.indexOf("task-2"));
  });

  it("survives a throwing codex-tasks provider", () => {
    writeFileSync(join(memoryDir, "2026-06-09.md"), "- day 9");
    const header = buildStateHeader({
      memoryDir,
      agentName: "test-agent",
      includeCodexTasks: true,
      codexTasksProvider: () => {
        throw new Error("registry unavailable");
      },
    });
    expect(header).toContain("day 9"); // other sections unaffected
    expect(header).not.toContain("Recent Codex Tasks");
  });
});

describe("getRecentMemories", () => {
  it("ignores non-date files and missing dirs", () => {
    expect(getRecentMemories(join(root, "nope"))).toEqual([]);
    writeFileSync(join(memoryDir, "notes.md"), "not a day file");
    writeFileSync(join(memoryDir, "2026-06-09.md"), "- day 9");
    const memories = getRecentMemories(memoryDir);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toContain("2026-06-09.md");
  });
});

describe("tailTruncate", () => {
  it("returns short content unchanged", () => {
    expect(tailTruncate("abc", 10)).toBe("abc");
  });
  it("keeps exactly maxChars of the tail plus a marker", () => {
    const out = tailTruncate("0123456789", 4);
    expect(out).toContain("6789");
    expect(out).toContain("6 chars truncated");
    expect(out).not.toContain("012345\n");
  });
});

describe("parseStateHeaderConfig", () => {
  it("defaults when both blocks are absent", () => {
    expect(parseStateHeaderConfig(undefined, undefined)).toEqual(DEFAULT_STATE_HEADER_CONFIG);
  });

  it("applies global block, agent overlay wins", () => {
    const cfg = parseStateHeaderConfig(
      { include_memory: false, codex_tasks_limit: 3, max_section_chars: 1000 },
      { include_memory: true, daily_memory_days: 5 }
    );
    expect(cfg.includeMemory).toBe(true); // agent overlay wins
    expect(cfg.codexTasksLimit).toBe(3); // global applies
    expect(cfg.maxSectionChars).toBe(1000);
    expect(cfg.dailyMemoryDays).toBe(5);
    expect(cfg.includeTasks).toBe(true); // untouched default
  });

  it("ignores wrong-typed values", () => {
    const cfg = parseStateHeaderConfig({
      include_memory: "yes" as unknown as boolean,
      daily_memory_days: -1,
      max_section_chars: "big" as unknown as number,
    });
    expect(cfg.includeMemory).toBe(true);
    expect(cfg.dailyMemoryDays).toBe(2);
    expect(cfg.maxSectionChars).toBe(8000);
  });
});

describe("evictedBehaviorFiles", () => {
  it("maps include flags to files 1:1", () => {
    expect(evictedBehaviorFiles(DEFAULT_STATE_HEADER_CONFIG)).toEqual([
      "MEMORY.md",
      "TASKS.md",
      "LESSONS.md",
      "OUTPUT-LOG.md",
    ]);
    expect(
      evictedBehaviorFiles({ ...DEFAULT_STATE_HEADER_CONFIG, includeMemory: false, includeOutputLog: false })
    ).toEqual(["TASKS.md", "LESSONS.md"]);
  });
});
