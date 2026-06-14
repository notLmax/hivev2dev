/**
 * claude-cli-runtime.ts — STUB for an uncommitted POC.
 *
 * The real implementation (tmux-driven interactive `claude` CLI —
 * the CLI-runtime POC) was never committed
 * and exists only on AC's machine (docs/v2-context/02-CODEBASE-DIVERGENCE.md
 * §C.1). Without this file a fresh checkout fails to compile, because both
 * src/core/agent.ts and src/discord/bot.ts import it.
 *
 * This stub keeps the build green and fails loudly at runtime if a
 * `runtime: claude-cli` agent actually runs on a box without the real file.
 * Restoring the real POC file over this stub is always safe — the exported
 * signatures match the call sites.
 */

import type {
  AgentConfig,
  AgentMessage,
  ImageAttachment,
  RunAgentResult,
} from "../core/agent.js";
import type { AgentRuntime } from "./types.js";

export async function runAgentClaudeCli(
  _prompt: string,
  config: AgentConfig,
  onMessage: (msg: AgentMessage) => void,
  _images?: ImageAttachment[]
): Promise<RunAgentResult> {
  const warning =
    `claude-cli runtime is not present in this build (uncommitted POC). ` +
    `Agent "${config.name}" cannot take turns — set \`runtime: sdk\` in config, ` +
    `or restore the POC implementation of src/runtimes/claude-cli-runtime.ts.`;
  console.error(`[claude-cli] ${warning}`);
  onMessage({ type: "error", content: `⚠️ ${warning}` });
  return { compacted: false };
}

/**
 * Kills the agent's interactive tmux session so /newsession spawns a fresh
 * claude process (real implementation). No-op in the stub.
 */
export function killSession(agentName: string): void {
  console.error(
    `[claude-cli] killSession(${agentName}) ignored — stub runtime (POC file not present).`
  );
}

/** AgentRuntime wrapper for the registry (src/runtimes/registry.ts). */
export const claudeCliRuntime: AgentRuntime = {
  name: "claude-cli",
  run: (o) => runAgentClaudeCli(o.prompt, o.config, o.onMessage, o.images),
};
