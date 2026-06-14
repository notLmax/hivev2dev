/**
 * types.ts — the runtime abstraction (04 §3).
 *
 * One interface, multiple backends. Formalizes the contract the SDK and ADK
 * paths already shared by duck-typing; deliberately keeps the callback shape
 * (onMessage) rather than an AsyncIterable — bot.ts consumes callbacks at four
 * call sites and the Discord layer is out of scope for v2 core work.
 *
 * Runtimes:
 *   claude-agent-sdk — default; Anthropic Agent SDK (consumes the plan SDK
 *                      credit, automatic caching). "sdk" in config is a legacy
 *                      alias, normalized in resolveAgentConfig.
 *   google-adk       — Gemini lane via @google/adk (committed, working).
 *   anthropic-compat — client-SDK loop with configurable baseURL (DeepSeek /
 *                      Ollama Cloud / Kimi). NOT IMPLEMENTED YET (WP3) —
 *                      registry throws; models.yaml validation rejects it.
 *   claude-cli       — tmux-driven interactive claude POC; stub in this repo.
 */

import type {
  AgentConfig,
  AgentMessage,
  ImageAttachment,
  RunAgentResult,
} from "../core/agent.js";

export type RuntimeName =
  | "claude-agent-sdk"
  | "google-adk"
  | "anthropic-compat"
  | "claude-cli";

export interface RuntimeRunOptions {
  /** Full prompt, Session State header already prepended by runAgent(). */
  prompt: string;
  config: AgentConfig;
  onMessage: (msg: AgentMessage) => void;
  onApprovalRequired: (message: string) => Promise<boolean>;
  sessionId?: string;
  images?: ImageAttachment[];
}

export interface AgentRuntime {
  readonly name: RuntimeName;
  run(opts: RuntimeRunOptions): Promise<RunAgentResult>;
}
