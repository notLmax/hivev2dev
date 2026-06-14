/**
 * Queen Bee acceptance: prompt determinism (04 §4 "Determinism test").
 *
 * The system prompt must be BYTE-IDENTICAL across WAL-discipline writes
 * (daily memory, TASKS.md, MEMORY.md, LESSONS.md, OUTPUT-LOG.md appends).
 * Edits to human-timescale files (IDENTITY.md etc.) are EXPECTED busts and
 * must surface in meta.fileHashes.
 *
 * Fixtures live in os.tmpdir() — never in agents/* (owner state).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";

import {
  buildSystemPromptDetailed,
  buildSystemPrompt,
  buildSafetyRules,
  buildToolGuidance,
  DEFAULT_EVICTED_FILES,
} from "../src/core/prompt-builder.js";
import { buildStateHeader } from "../src/core/state-header.js";

const SAFETY = buildSafetyRules({
  blocked_commands: ["rm -rf /"],
  allowed_paths: ["/tmp"],
  protected_paths: ["/etc"],
});

let root: string;
let behaviorDir: string;
let memoryDir: string;

function buildOpts() {
  return {
    agentName: "test-agent",
    behaviorDir,
    safetyRules: SAFETY,
    toolGuidance: buildToolGuidance(),
  };
}

beforeEach(() => {
  // Fixture hive root: behaviorDir at <root>/agents/test-agent so the
  // builder's ../../shared and ../../skills derivations resolve inside root.
  root = mkdtempSync(join(tmpdir(), "hive-determinism-"));
  behaviorDir = join(root, "agents", "test-agent");
  memoryDir = join(behaviorDir, "memory");
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });

  writeFileSync(join(root, "shared", "CRITICAL-RULES.md"), "# Critical Rules\n\nBe safe.");
  writeFileSync(join(root, "shared", "GLOBAL-TOOLS.md"), "# Global Tools\n\nSome tools.");
  writeFileSync(join(behaviorDir, "IDENTITY.md"), "# Identity\n\nI am the test agent.");
  writeFileSync(join(behaviorDir, "SOUL.md"), "# Soul\n\nCalm.");
  writeFileSync(join(behaviorDir, "MEMORY.md"), "# Memory\n\n- long-term fact");
  writeFileSync(join(behaviorDir, "TASKS.md"), "# Tasks\n\n- [ ] initial task");
  writeFileSync(join(behaviorDir, "LESSONS.md"), "# Lessons\n\n- lesson one");
  writeFileSync(join(behaviorDir, "OUTPUT-LOG.md"), "# Output Log\n\n- did a thing");
  // Fixed past dates — no dependence on the current clock (midnight-safe).
  writeFileSync(join(memoryDir, "2026-06-08.md"), "- old memory");
  writeFileSync(join(memoryDir, "2026-06-09.md"), "- newer memory");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("prompt determinism across WAL writes (04 §4 acceptance)", () => {
  it("is byte-identical after daily-memory, TASKS, MEMORY, LESSONS, OUTPUT-LOG appends", () => {
    const a = buildSystemPromptDetailed(buildOpts());

    // Simulate the WAL discipline: state writes mid-session.
    appendFileSync(join(memoryDir, "2026-06-09.md"), "\n- appended mid-session");
    appendFileSync(join(behaviorDir, "TASKS.md"), "\n- [ ] new task");
    appendFileSync(join(behaviorDir, "MEMORY.md"), "\n- new fact");
    appendFileSync(join(behaviorDir, "LESSONS.md"), "\n- new lesson");
    appendFileSync(join(behaviorDir, "OUTPUT-LOG.md"), "\n- another thing");

    const b = buildSystemPromptDetailed(buildOpts());

    expect(b.text).toBe(a.text); // byte-identical
    expect(b.meta.hash).toBe(a.meta.hash);
    // ...while the churn meter sees the writes:
    expect(b.meta.fileHashes["TASKS.md"]).not.toBe(a.meta.fileHashes["TASKS.md"]);
    expect(b.meta.fileHashes["MEMORY.md"]).not.toBe(a.meta.fileHashes["MEMORY.md"]);
  });

  it("changes (expected bust) when a human-timescale file is edited, visible in fileHashes", () => {
    const a = buildSystemPromptDetailed(buildOpts());
    appendFileSync(join(behaviorDir, "IDENTITY.md"), "\nAlso: curious.");
    const b = buildSystemPromptDetailed(buildOpts());

    expect(b.text).not.toBe(a.text);
    expect(b.meta.fileHashes["IDENTITY.md"]).not.toBe(a.meta.fileHashes["IDENTITY.md"]);
  });

  it("excludes evicted mutable files from the prompt but renders them in the state header", () => {
    const { text } = buildSystemPromptDetailed(buildOpts());

    expect(text).not.toContain("initial task"); // TASKS.md content
    expect(text).not.toContain("long-term fact"); // MEMORY.md content
    expect(text).not.toContain("lesson one"); // LESSONS.md content
    expect(text).not.toContain("did a thing"); // OUTPUT-LOG.md content
    expect(text).toContain("I am the test agent."); // IDENTITY.md stays
    expect(text).toContain("Be safe."); // shared rules stay

    const header = buildStateHeader({
      memoryDir,
      behaviorDir,
      agentName: "test-agent",
      behaviorFiles: [...DEFAULT_EVICTED_FILES],
      includeCodexTasks: false,
    });
    expect(header).toContain("# Session State");
    expect(header).toContain("initial task");
    expect(header).toContain("long-term fact");
    expect(header).toContain("lesson one");
    expect(header).toContain("did a thing");
    expect(header).toContain("newer memory");
  });

  it("still hashes evicted files into fileHashes", () => {
    const { meta } = buildSystemPromptDetailed(buildOpts());
    for (const file of DEFAULT_EVICTED_FILES) {
      expect(meta.fileHashes[file], `${file} should be hashed`).toBeTruthy();
    }
  });

  it("meta.hash is sha256[0:12] of the text; chars matches", () => {
    const { text, meta } = buildSystemPromptDetailed(buildOpts());
    const expected = createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
    expect(meta.hash).toBe(expected);
    expect(meta.chars).toBe(text.length);
  });

  it("orders extra behavior files deterministically and reproducibly", () => {
    writeFileSync(join(behaviorDir, "ZEBRA.md"), "zebra content");
    writeFileSync(join(behaviorDir, "ALPHA.md"), "alpha content");

    const a = buildSystemPrompt(buildOpts());
    const b = buildSystemPrompt(buildOpts());
    expect(a).toBe(b);
    // Precedence files first, then remaining alphabetical: ALPHA before ZEBRA.
    expect(a.indexOf("alpha content")).toBeGreaterThan(a.indexOf("I am the test agent."));
    expect(a.indexOf("zebra content")).toBeGreaterThan(a.indexOf("alpha content"));
  });

  it("respects an explicit empty evict list (rollback path)", () => {
    const { text } = buildSystemPromptDetailed({ ...buildOpts(), evictFiles: [] });
    expect(text).toContain("initial task");
    expect(text).toContain("long-term fact");
  });
});
