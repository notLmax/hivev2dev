/**
 * model-catalog.ts — config/models.yaml loader + resolution (04 §3).
 *
 * Single source of truth for model tiers: pinned model IDs, runtime, endpoint,
 * pricing, and per-agent assignments. STRICTLY ADDITIVE:
 *
 *   - no models.yaml file            → resolution passes raw config.yaml
 *                                       values through, byte-identical to
 *                                       pre-catalog behavior
 *   - agent not in the agents block  → same passthrough (unless its raw
 *                                       `model:` string happens to be a
 *                                       catalog KEY — the opt-in shorthand)
 *   - assignment present             → catalog wins: pinned ID + runtime +
 *                                       pricing + caps travel as
 *                                       AgentConfig.modelInfo
 *
 * Precedence: models.yaml `agents:` > config.yaml agentDef.model-as-catalog-key
 * > raw passthrough. Model assignment is per-agent at session start — never
 * per-turn (04 §9: per-turn routing busts caches and forks sessions).
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import yaml from "js-yaml";
import type { RuntimeName } from "../runtimes/types.js";

/** USD per MTok. cachedIn/cacheWrite optional — default derived from `in`. */
export interface ModelPrice {
  in: number;
  out: number;
  cachedIn?: number;
  cacheWrite?: number;
}

export interface SpendCaps {
  dailyUSD?: number;
  monthlyUSD?: number;
}

export interface CatalogEntry {
  key: string;
  runtime: RuntimeName;
  /** Exact pinned model ID sent to the provider. */
  modelId: string;
  baseURL?: string;
  /** Env var that must be set for this entry to be usable. */
  apiKeyEnv?: string;
  price?: ModelPrice;
  contextWindow?: number;
  /** Tiers allowed to use this entry (e.g. ["eng"] for Opus). Informational until tiers are enforced. */
  restrictedTo?: string[];
  /** Provider quirk profile name for the anthropic-compat normalizer (WP3). */
  quirks?: string;
}

export interface AgentModelAssignment {
  /** Catalog key. */
  model: string;
  tier?: string;
  contextBudget?: number;
  caps?: SpendCaps;
}

export interface ModelCatalog {
  entries: Record<string, CatalogEntry>;
  agents: Record<string, AgentModelAssignment>;
  defaultCaps?: SpendCaps;
  /**
   * Fleet default tier (defaults.model): catalog key applied to every agent
   * with no explicit assignment anywhere — the org-wide flip switch shipped
   * via hive update. Soft semantics in resolveModel: applies ONLY when the
   * entry's api_key_env is present and no explicit config.yaml runtime
   * disagrees; otherwise the agent stays on exact passthrough (warning,
   * never a boot failure). "none" cancels a shipped default locally.
   */
  defaultModel?: string;
}

/** What resolution produces — carried on AgentConfig.modelInfo. */
export interface ResolvedModel {
  modelId: string;
  runtime: RuntimeName;
  /** Set only when a catalog entry was used. */
  catalogKey?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  price?: ModelPrice;
  contextBudget?: number;
  contextWindow?: number;
  tier?: string;
  caps?: SpendCaps;
  /** Provider quirk profile for the anthropic-compat normalizer. */
  quirks?: string;
}

/** Runtimes that can actually be dispatched today (registry.ts). */
const IMPLEMENTED_RUNTIMES: ReadonlySet<string> = new Set([
  "claude-agent-sdk",
  "google-adk",
  "claude-cli",
  "anthropic-compat", // WP3, landed 2026-06-10
]);

const RUNTIME_NAMES: ReadonlySet<string> = new Set([
  "claude-agent-sdk",
  "google-adk",
  "claude-cli",
  "anthropic-compat",
]);

function parseCaps(raw: unknown): SpendCaps | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const caps: SpendCaps = {};
  if (typeof r.daily_usd === "number" && r.daily_usd >= 0) caps.dailyUSD = r.daily_usd;
  if (typeof r.monthly_usd === "number" && r.monthly_usd >= 0) caps.monthlyUSD = r.monthly_usd;
  return Object.keys(caps).length > 0 ? caps : undefined;
}

function parsePrice(raw: unknown): ModelPrice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.in !== "number" || typeof r.out !== "number") return undefined;
  const price: ModelPrice = { in: r.in, out: r.out };
  if (typeof r.cached_in === "number") price.cachedIn = r.cached_in;
  if (typeof r.cache_write === "number") price.cacheWrite = r.cache_write;
  return price;
}

/**
 * Loads config/models.yaml plus an optional config/models.local.yaml overlay.
 *
 * The split is the `hive update` contract (04 §7): models.yaml is SHIPPED —
 * updates can repin model IDs and prices fleet-wide; models.local.yaml is
 * OWNER STATE (gitignored here, PRESERVE_LIST in the employee repo) — it
 * holds per-agent assignments and cap overrides and survives every update.
 * Local wins on conflicts (entries, agents, defaults).
 *
 * Returns null when neither file exists — the everything-stays-as-it-was
 * signal. Throws on a present-but-malformed file (a broken catalog must not
 * be silently ignored).
 */
export function loadModelCatalog(path?: string, localPath?: string): ModelCatalog | null {
  const filePath = path ?? join(process.cwd(), "config", "models.yaml");
  // Default the overlay next to the main file so tests/fixtures isolate.
  const localFilePath =
    localPath ?? join(filePath, "..", "models.local.yaml");

  const main = existsSync(filePath) ? parseCatalogFile(filePath) : null;
  const local = existsSync(localFilePath) ? parseCatalogFile(localFilePath) : null;
  if (!main && !local) return null;
  if (!local) return main;
  if (!main) return local;
  return {
    entries: { ...main.entries, ...local.entries },
    agents: { ...main.agents, ...local.agents },
    defaultCaps: local.defaultCaps ?? main.defaultCaps,
    defaultModel: local.defaultModel ?? main.defaultModel,
  };
}

function parseCatalogFile(filePath: string): ModelCatalog {
  const label = basename(filePath);
  const raw = yaml.load(readFileSync(filePath, "utf-8")) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { entries: {}, agents: {} };

  const entries: Record<string, CatalogEntry> = {};
  const catalogBlock = (raw.model_catalog ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, def] of Object.entries(catalogBlock)) {
    if (!def || typeof def !== "object") {
      throw new Error(`${label}: model_catalog.${key} is not a mapping`);
    }
    const runtime = String(def.runtime ?? "");
    if (!RUNTIME_NAMES.has(runtime)) {
      throw new Error(
        `${label}: model_catalog.${key}.runtime "${runtime}" is not one of: ${[...RUNTIME_NAMES].join(", ")}`
      );
    }
    const modelId = def.id;
    if (typeof modelId !== "string" || !modelId) {
      throw new Error(`${label}: model_catalog.${key}.id (pinned model ID) is required`);
    }
    entries[key] = {
      key,
      runtime: runtime as RuntimeName,
      modelId,
      baseURL: typeof def.base_url === "string" ? def.base_url : undefined,
      apiKeyEnv: typeof def.api_key_env === "string" ? def.api_key_env : undefined,
      price: parsePrice(def.price),
      contextWindow: typeof def.context_window === "number" ? def.context_window : undefined,
      restrictedTo: Array.isArray(def.restricted_to) ? def.restricted_to.map(String) : undefined,
      quirks: typeof def.quirks === "string" ? def.quirks : undefined,
    };
  }

  const agents: Record<string, AgentModelAssignment> = {};
  const agentsBlock = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, def] of Object.entries(agentsBlock)) {
    if (!def || typeof def !== "object" || typeof def.model !== "string") {
      throw new Error(`${label}: agents.${name}.model (catalog key) is required`);
    }
    agents[name] = {
      model: def.model,
      tier: typeof def.tier === "string" ? def.tier : undefined,
      contextBudget: typeof def.context_budget === "number" ? def.context_budget : undefined,
      caps: parseCaps(def.caps),
    };
  }

  const defaults = (raw.defaults ?? {}) as Record<string, unknown>;
  return {
    entries,
    agents,
    defaultCaps: parseCaps(defaults.caps),
    defaultModel: typeof defaults.model === "string" && defaults.model ? defaults.model : undefined,
  };
}

/**
 * Writes (or removes, with null) an agent's model assignment in
 * config/models.local.yaml — the owner-state overlay that survives updates.
 * Returns the previous assignment key (null if none) so callers can revert.
 * Used by the /swap command (06-ROLLOUT-PLAYBOOK §2).
 */
export function assignAgentModel(
  agentName: string,
  catalogKey: string | null,
  localPath?: string
): string | null {
  const filePath = localPath ?? join(process.cwd(), "config", "models.local.yaml");
  let raw: Record<string, any> = {};
  if (existsSync(filePath)) {
    raw = (yaml.load(readFileSync(filePath, "utf-8")) as Record<string, any>) ?? {};
  }
  if (!raw.agents || typeof raw.agents !== "object") raw.agents = {};
  const prev = raw.agents[agentName];
  const previous = prev && typeof prev.model === "string" ? (prev.model as string) : null;
  if (catalogKey === null) {
    delete raw.agents[agentName];
  } else {
    raw.agents[agentName] = { ...(raw.agents[agentName] ?? {}), model: catalogKey };
  }
  writeFileSync(filePath, yaml.dump(raw), "utf-8");
  return previous;
}

function resolveEntry(
  catalog: ModelCatalog,
  agentName: string,
  entry: CatalogEntry,
  assignment: AgentModelAssignment | undefined,
  runtimeWasExplicit: boolean,
  rawRuntime: RuntimeName,
  env: NodeJS.ProcessEnv
): ResolvedModel {
  if (!IMPLEMENTED_RUNTIMES.has(entry.runtime)) {
    throw new Error(
      `Agent "${agentName}" is assigned catalog model "${entry.key}" on runtime "${entry.runtime}", ` +
        `which is not implemented yet — pick a ${[...IMPLEMENTED_RUNTIMES].join("/")} entry`
    );
  }
  if (runtimeWasExplicit && rawRuntime !== entry.runtime) {
    throw new Error(
      `Agent "${agentName}": config.yaml runtime "${rawRuntime}" conflicts with catalog model ` +
        `"${entry.key}" (runtime "${entry.runtime}") — remove one; the catalog does not guess`
    );
  }
  if (entry.apiKeyEnv && !env[entry.apiKeyEnv]) {
    throw new Error(
      `Agent "${agentName}" is assigned catalog model "${entry.key}" which requires ` +
        `${entry.apiKeyEnv} in .env — set it or change the assignment`
    );
  }
  return {
    modelId: entry.modelId,
    runtime: entry.runtime,
    catalogKey: entry.key,
    baseURL: entry.baseURL,
    apiKeyEnv: entry.apiKeyEnv,
    price: entry.price,
    contextBudget: assignment?.contextBudget,
    contextWindow: entry.contextWindow,
    tier: assignment?.tier,
    caps: assignment?.caps ?? catalog.defaultCaps,
    quirks: entry.quirks,
  };
}

/**
 * Resolves an agent's model. Precedence:
 *   1. models.yaml/models.local.yaml agents.<name>.model (catalog key — must exist)
 *   2. config.yaml agentDef.model used AS a catalog key (opt-in shorthand)
 *   3. defaults.model — the fleet default tier (SOFT: see below)
 *   4. raw passthrough — exact pre-catalog behavior
 * Throws with doctor-style messages when THIS agent's assignment is broken
 * (missing key, missing env var, unimplemented runtime, runtime conflict) —
 * a misconfigured agent must fail loudly at startup, not at first turn.
 *
 * EXCEPTION — the fleet default (3) never throws: an org-wide flip shipped
 * via hive update must not brick installs that haven't received the API key
 * yet, and an explicit config.yaml `runtime:` is treated as a deliberate
 * opt-out. In those cases the agent stays on passthrough with a console
 * warning. Per-agent opt-outs: assign a tier in models.local.yaml (wins), or
 * set `defaults: { model: none }` there to cancel the shipped default.
 */
export function resolveModel(
  catalog: ModelCatalog | null,
  agentName: string,
  rawModel: string,
  rawRuntime: RuntimeName,
  runtimeWasExplicit: boolean,
  env: NodeJS.ProcessEnv = process.env
): ResolvedModel {
  if (catalog) {
    const assignment = catalog.agents[agentName];
    if (assignment) {
      const entry = catalog.entries[assignment.model];
      if (!entry) {
        throw new Error(
          `models.yaml assigns agent "${agentName}" model "${assignment.model}", ` +
            `but model_catalog has no such key`
        );
      }
      return resolveEntry(catalog, agentName, entry, assignment, runtimeWasExplicit, rawRuntime, env);
    }
    const keyEntry = catalog.entries[rawModel];
    if (keyEntry) {
      return resolveEntry(catalog, agentName, keyEntry, undefined, runtimeWasExplicit, rawRuntime, env);
    }
    const defKey = catalog.defaultModel;
    if (defKey && defKey !== "none") {
      const defEntry = catalog.entries[defKey];
      if (!defEntry) {
        console.warn(
          `[catalog] defaults.model "${defKey}" is not in model_catalog — "${agentName}" stays on passthrough`
        );
      } else if (runtimeWasExplicit && rawRuntime !== defEntry.runtime) {
        // Explicit config.yaml runtime = deliberate opt-out of the fleet default.
      } else if (!IMPLEMENTED_RUNTIMES.has(defEntry.runtime)) {
        console.warn(
          `[catalog] defaults.model "${defKey}" runs on unimplemented runtime "${defEntry.runtime}" — "${agentName}" stays on passthrough`
        );
      } else if (defEntry.apiKeyEnv && !env[defEntry.apiKeyEnv]) {
        console.warn(
          `[catalog] fleet default "${defKey}" needs ${defEntry.apiKeyEnv} in .env (not set) — "${agentName}" stays on passthrough until it is`
        );
      } else {
        return resolveEntry(catalog, agentName, defEntry, undefined, runtimeWasExplicit, rawRuntime, env);
      }
    }
  }
  // Passthrough — no catalog, or raw model string isn't a key.
  return { modelId: rawModel, runtime: rawRuntime };
}

/**
 * Whole-catalog audit for startup logging: problems with entries NOT assigned
 * to the running agent are warnings (the doctor pattern); the running agent's
 * own problems throw in resolveModel instead.
 */
export function validateCatalog(
  catalog: ModelCatalog,
  env: NodeJS.ProcessEnv = process.env
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [name, assignment] of Object.entries(catalog.agents)) {
    const entry = catalog.entries[assignment.model];
    if (!entry) {
      errors.push(`agents.${name}: model "${assignment.model}" is not in model_catalog`);
      continue;
    }
    if (!IMPLEMENTED_RUNTIMES.has(entry.runtime)) {
      errors.push(
        `agents.${name}: "${assignment.model}" runs on "${entry.runtime}" which is not implemented yet`
      );
    }
    if (entry.apiKeyEnv && !env[entry.apiKeyEnv]) {
      warnings.push(`agents.${name}: "${assignment.model}" needs ${entry.apiKeyEnv} in .env (not set)`);
    }
  }

  for (const entry of Object.values(catalog.entries)) {
    if (entry.price && (entry.price.in < 0 || entry.price.out < 0)) {
      errors.push(`model_catalog.${entry.key}: negative price`);
    }
    if (!IMPLEMENTED_RUNTIMES.has(entry.runtime)) {
      warnings.push(
        `model_catalog.${entry.key}: runtime "${entry.runtime}" not implemented yet — assignable after WP3`
      );
    }
  }

  if (catalog.defaultModel && catalog.defaultModel !== "none") {
    const def = catalog.entries[catalog.defaultModel];
    if (!def) {
      errors.push(`defaults.model "${catalog.defaultModel}" is not in model_catalog`);
    } else if (def.apiKeyEnv && !env[def.apiKeyEnv]) {
      warnings.push(
        `defaults.model "${catalog.defaultModel}" needs ${def.apiKeyEnv} in .env (not set) — ` +
          `the fleet default is INERT: unassigned agents stay on passthrough`
      );
    }
  }

  return { errors, warnings };
}
