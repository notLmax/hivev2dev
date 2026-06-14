/**
 * tool-registry.ts — runtime-agnostic tool layer (04 §3, Queen Bee 04 §4.8).
 *
 * Tools for runtimes where WE own the agent loop (anthropic-compat; the ADK
 * lane keeps its own FunctionTools for now — consolidation is tracked
 * cleanup). Input schemas are PLAIN JSON SCHEMA — Anthropic's native tool
 * format — so there is no zod-version bridging and the schemas are identical
 * for every agent (per-agent schema variance fragments the prompt cache
 * fleet-wide; see claude-sdk-runtime.ts invariants).
 *
 * Hygiene caps (the other half of Queen Bee): oversized tool results are
 * silent context filler re-billed every turn — Bash/WebFetch 16 KB, Glob 250
 * paths, Grep bounded. Same numbers as the ADK lane and the SDK lane's env
 * caps.
 */

export interface ToolContext {
  workingDir: string;
  behaviorDir: string;
  agentName: string;
}

export interface SharedToolResult {
  text: string;
  isError?: boolean;
}

export interface SharedTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input (Anthropic `input_schema` shape). */
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, any>, ctx: ToolContext): Promise<SharedToolResult>;
}

/** Anthropic Messages API tool definition. */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function toAnthropicTools(tools: SharedTool[]): AnthropicToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

import { createBuiltinTools } from "./builtin-tools.js";
import { createHiveTools } from "./hive-tools.js";

/**
 * The full shared tool set. ONE fixed list — never vary per-turn or
 * per-session (tool defs hash first in the cache prefix).
 */
export function createSharedTools(): SharedTool[] {
  return [...createBuiltinTools(), ...createHiveTools()];
}
