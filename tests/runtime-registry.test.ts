/**
 * Runtime registry + config-resolution behavior preservation (04 §3).
 * The extraction must be zero-behavior-change: a config.yaml-only setup (no
 * models.yaml, no state_header block) resolves identical {model, runtime}.
 */

import { describe, it, expect } from "vitest";
import { getRuntime } from "../src/runtimes/registry.js";
import { resolveAgentConfig } from "../src/core/agent.js";

const GLOBAL_CONFIG = {
  model: "claude-opus-4-7[1m]",
  codex: { enabled: true, command: "npx", args: ["-y", "codex", "mcp-server"] },
  safety: { blocked_commands: [], allowed_paths: [], protected_paths: [] },
  agents: {
    plain: { behavior_dir: "agents/plain" },
    overridden: { behavior_dir: "agents/overridden", model: "claude-fable-5" },
    cli: { behavior_dir: "agents/cli", runtime: "claude-cli" },
    gemini: { behavior_dir: "agents/gemini", runtime: "google-adk", model: "gemini-3.5-flash" },
  },
};

describe("getRuntime", () => {
  it("resolves claude-agent-sdk to the SDK runtime", async () => {
    const rt = await getRuntime("claude-agent-sdk");
    expect(rt.name).toBe("claude-agent-sdk");
    expect(typeof rt.run).toBe("function");
  });

  it("resolves claude-cli to the loud stub", async () => {
    const rt = await getRuntime("claude-cli");
    expect(rt.name).toBe("claude-cli");
  });

  it("resolves anthropic-compat (WP3)", async () => {
    const rt = await getRuntime("anthropic-compat");
    expect(rt.name).toBe("anthropic-compat");
    expect(typeof rt.run).toBe("function");
  });
});

describe("resolveAgentConfig behavior preservation", () => {
  it("global model + legacy 'sdk' default runtime", () => {
    const cfg = resolveAgentConfig(GLOBAL_CONFIG, "plain");
    expect(cfg.model).toBe("claude-opus-4-7[1m]");
    expect(cfg.runtime).toBe("claude-agent-sdk"); // normalized legacy "sdk"
  });

  it("per-agent model override wins", () => {
    expect(resolveAgentConfig(GLOBAL_CONFIG, "overridden").model).toBe("claude-fable-5");
  });

  it("explicit runtimes pass through", () => {
    expect(resolveAgentConfig(GLOBAL_CONFIG, "cli").runtime).toBe("claude-cli");
    expect(resolveAgentConfig(GLOBAL_CONFIG, "gemini").runtime).toBe("google-adk");
  });

  it("absent state_header block resolves to full-eviction defaults", () => {
    const cfg = resolveAgentConfig(GLOBAL_CONFIG, "plain");
    expect(cfg.stateHeader.includeMemory).toBe(true);
    expect(cfg.stateHeader.dailyMemoryDays).toBe(2);
  });

  it("unknown agent throws", () => {
    expect(() => resolveAgentConfig(GLOBAL_CONFIG, "nope")).toThrow(/not found/);
  });
});
