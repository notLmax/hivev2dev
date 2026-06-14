/**
 * registry.ts — runtime lookup (04 §3).
 *
 * Lazy dynamic imports so heavyweight deps (@google/adk, better-sqlite3, and
 * later @anthropic-ai/sdk) only load in processes whose agent actually uses
 * that runtime — same behavior as the old inline dispatch in runAgent().
 */

import type { AgentRuntime, RuntimeName } from "./types.js";

export async function getRuntime(name: RuntimeName): Promise<AgentRuntime> {
  // Legacy alias tolerance: resolveAgentConfig normalizes "sdk", but callers
  // that construct AgentConfig directly (scripts, ports) may still pass it.
  if ((name as string) === "sdk") name = "claude-agent-sdk";
  switch (name) {
    case "claude-agent-sdk":
      return (await import("./claude-sdk-runtime.js")).claudeSdkRuntime;
    case "google-adk":
      return (await import("./google-adk-runtime.js")).googleAdkRuntime;
    case "claude-cli":
      return (await import("./claude-cli-runtime.js")).claudeCliRuntime;
    case "anthropic-compat":
      return (await import("./anthropic-compat/runtime.js")).anthropicCompatRuntime;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown runtime: ${exhaustive}`);
    }
  }
}
