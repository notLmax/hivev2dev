/**
 * Model catalog tests (04 §3): precedence matrix, additive defaults,
 * doctor-style validation. Fixtures in os.tmpdir().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  loadModelCatalog,
  resolveModel,
  validateCatalog,
  assignAgentModel,
  type ModelCatalog,
} from "../src/core/model-catalog.js";

const YAML = `
model_catalog:
  sonnet:
    runtime: claude-agent-sdk
    id: claude-sonnet-4-6
    price: { in: 3.00, out: 15.00, cached_in: 0.30, cache_write: 3.75 }
  gemini-flash:
    runtime: google-adk
    id: gemini-3.5-flash
    api_key_env: TEST_GEMINI_KEY
    price: { in: 1.50, out: 9.00 }
  deepseek-flash:
    runtime: anthropic-compat
    base_url: https://api.deepseek.com
    id: deepseek-v4-flash
    api_key_env: TEST_DEEPSEEK_KEY
    price: { in: 0.14, out: 0.28, cached_in: 0.0028 }
agents:
  clerk: { model: sonnet, tier: standard, context_budget: 200000, caps: { daily_usd: 2.5 } }
  capless: { model: sonnet }
  broken: { model: no-such-key }
  too-early: { model: deepseek-flash }
defaults:
  caps: { daily_usd: 25, monthly_usd: 300 }
`;

let dir: string;
let catalogPath: string;
let catalog: ModelCatalog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hive-models-"));
  catalogPath = join(dir, "models.yaml");
  writeFileSync(catalogPath, YAML);
  catalog = loadModelCatalog(catalogPath)!;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadModelCatalog", () => {
  it("returns null when the file is absent (everything-as-before signal)", () => {
    expect(loadModelCatalog(join(dir, "nope.yaml"))).toBeNull();
  });

  it("parses entries, assignments, defaults", () => {
    expect(catalog.entries.sonnet.modelId).toBe("claude-sonnet-4-6");
    expect(catalog.entries["deepseek-flash"].baseURL).toBe("https://api.deepseek.com");
    expect(catalog.agents.clerk.caps?.dailyUSD).toBe(2.5);
    expect(catalog.defaultCaps).toEqual({ dailyUSD: 25, monthlyUSD: 300 });
  });

  it("throws on malformed entries (broken catalog must not be ignored)", () => {
    writeFileSync(catalogPath, "model_catalog:\n  bad:\n    runtime: nonsense\n    id: x\n");
    expect(() => loadModelCatalog(catalogPath)).toThrow(/runtime/);
    writeFileSync(catalogPath, "model_catalog:\n  bad:\n    runtime: claude-agent-sdk\n");
    expect(() => loadModelCatalog(catalogPath)).toThrow(/id .*required/);
  });

  it("merges models.local.yaml overlay — local assignments/caps win, shipped catalog stays", () => {
    const localPath = join(dir, "models.local.yaml");
    writeFileSync(
      localPath,
      [
        "agents:",
        "  clerk: { model: gemini-flash }                      # reassigns shipped default",
        "  my-own-agent: { model: sonnet, caps: { daily_usd: 1 } }",
        "defaults:",
        "  caps: { daily_usd: 5 }",
      ].join("\n")
    );
    const merged = loadModelCatalog(catalogPath, localPath)!;
    expect(merged.agents.clerk.model).toBe("gemini-flash"); // local wins
    expect(merged.agents.capless.model).toBe("sonnet"); // shipped survives
    expect(merged.agents["my-own-agent"].caps?.dailyUSD).toBe(1);
    expect(merged.defaultCaps).toEqual({ dailyUSD: 5 }); // local defaults win
    expect(merged.entries.sonnet.modelId).toBe("claude-sonnet-4-6"); // catalog intact
  });

  it("local overlay alone works (no shipped catalog)", () => {
    const localPath = join(dir, "models.local.yaml");
    writeFileSync(localPath, "model_catalog:\n  mine: { runtime: claude-agent-sdk, id: claude-haiku-4-5 }\nagents:\n  a: { model: mine }\n");
    const cat = loadModelCatalog(join(dir, "absent.yaml"), localPath)!;
    expect(cat.entries.mine.modelId).toBe("claude-haiku-4-5");
  });
});

describe("resolveModel precedence", () => {
  const env = { TEST_GEMINI_KEY: "g", TEST_DEEPSEEK_KEY: "d" } as NodeJS.ProcessEnv;

  it("1: models.yaml assignment wins over raw config model", () => {
    const r = resolveModel(catalog, "clerk", "claude-opus-4-7[1m]", "claude-agent-sdk", false, env);
    expect(r.modelId).toBe("claude-sonnet-4-6");
    expect(r.catalogKey).toBe("sonnet");
    expect(r.tier).toBe("standard");
    expect(r.contextBudget).toBe(200000);
    expect(r.caps).toEqual({ dailyUSD: 2.5 });
  });

  it("assignment without caps inherits defaults.caps", () => {
    const r = resolveModel(catalog, "capless", "whatever", "claude-agent-sdk", false, env);
    expect(r.caps).toEqual({ dailyUSD: 25, monthlyUSD: 300 });
  });

  it("2: raw model string used as catalog key (opt-in shorthand)", () => {
    const r = resolveModel(catalog, "anyone", "gemini-flash", "claude-agent-sdk", false, env);
    expect(r.modelId).toBe("gemini-3.5-flash");
    expect(r.runtime).toBe("google-adk");
  });

  it("3: passthrough for non-key strings and for null catalog", () => {
    const r = resolveModel(catalog, "anyone", "claude-opus-4-7[1m]", "claude-agent-sdk", false, env);
    expect(r).toEqual({ modelId: "claude-opus-4-7[1m]", runtime: "claude-agent-sdk" });
    const r2 = resolveModel(null, "clerk", "raw-model", "google-adk", true, env);
    expect(r2).toEqual({ modelId: "raw-model", runtime: "google-adk" });
  });

  it("throws on assignment to a missing key", () => {
    expect(() => resolveModel(catalog, "broken", "x", "claude-agent-sdk", false, env)).toThrow(
      /no such key/
    );
  });

  it("resolves anthropic-compat entries (WP3 landed)", () => {
    const r = resolveModel(catalog, "too-early", "x", "claude-agent-sdk", false, env);
    expect(r.runtime).toBe("anthropic-compat");
    expect(r.modelId).toBe("deepseek-v4-flash");
    expect(r.baseURL).toBe("https://api.deepseek.com");
  });

  it("throws on missing api_key_env for the assigned agent", () => {
    const r = () =>
      resolveModel(catalog, "anyone", "gemini-flash", "claude-agent-sdk", false, {} as NodeJS.ProcessEnv);
    expect(r).toThrow(/TEST_GEMINI_KEY/);
  });

  it("throws on explicit runtime conflicting with the catalog entry", () => {
    expect(() => resolveModel(catalog, "anyone", "gemini-flash", "claude-agent-sdk", true, env)).toThrow(
      /conflicts/
    );
    // ...but a MATCHING explicit runtime is fine.
    const ok = resolveModel(catalog, "anyone", "gemini-flash", "google-adk", true, env);
    expect(ok.runtime).toBe("google-adk");
  });
});

describe("resolveModel fleet default (defaults.model)", () => {
  const env = { TEST_GEMINI_KEY: "g", TEST_DEEPSEEK_KEY: "d" } as NodeJS.ProcessEnv;
  const withDefault = (model: string) => {
    writeFileSync(catalogPath, YAML.replace("defaults:", `defaults:\n  model: ${model}`));
    return loadModelCatalog(catalogPath)!;
  };

  it("applies to unassigned agents when the lane's key is present", () => {
    const cat = withDefault("deepseek-flash");
    const r = resolveModel(cat, "unassigned", "claude-opus-4-8", "claude-agent-sdk", false, env);
    expect(r.catalogKey).toBe("deepseek-flash");
    expect(r.runtime).toBe("anthropic-compat");
    expect(r.caps).toEqual({ dailyUSD: 25, monthlyUSD: 300 }); // default caps ride along
  });

  it("soft-falls to passthrough when the key env is missing (never throws)", () => {
    const cat = withDefault("deepseek-flash");
    const r = resolveModel(cat, "unassigned", "claude-opus-4-8", "claude-agent-sdk", false, {
      TEST_GEMINI_KEY: "g",
    } as NodeJS.ProcessEnv);
    expect(r).toEqual({ modelId: "claude-opus-4-8", runtime: "claude-agent-sdk" });
  });

  it("loses to explicit assignments and to model-as-catalog-key", () => {
    const cat = withDefault("deepseek-flash");
    expect(resolveModel(cat, "clerk", "x", "claude-agent-sdk", false, env).catalogKey).toBe("sonnet");
    expect(resolveModel(cat, "anyone", "gemini-flash", "claude-agent-sdk", false, env).catalogKey).toBe(
      "gemini-flash"
    );
  });

  it("explicit config.yaml runtime opts the agent out (no throw, passthrough)", () => {
    const cat = withDefault("deepseek-flash");
    const r = resolveModel(cat, "pinned", "claude-sonnet-4-6", "claude-agent-sdk", true, env);
    expect(r).toEqual({ modelId: "claude-sonnet-4-6", runtime: "claude-agent-sdk" });
  });

  it("local `defaults: { model: none }` cancels a shipped default", () => {
    writeFileSync(catalogPath, YAML.replace("defaults:", "defaults:\n  model: deepseek-flash"));
    const localPath = join(dir, "models.local.yaml");
    writeFileSync(localPath, "defaults:\n  model: none\n");
    const cat = loadModelCatalog(catalogPath, localPath)!;
    const r = resolveModel(cat, "unassigned", "raw-model", "claude-agent-sdk", false, env);
    expect(r).toEqual({ modelId: "raw-model", runtime: "claude-agent-sdk" });
  });

  it("validateCatalog warns that the default is inert without its key", () => {
    const cat = withDefault("deepseek-flash");
    const { warnings } = validateCatalog(cat, {} as NodeJS.ProcessEnv);
    expect(warnings.some((w) => w.includes("INERT"))).toBe(true);
    const bad = withDefault("no-such-tier");
    const { errors } = validateCatalog(bad, env);
    expect(errors.some((e) => e.includes("no-such-tier"))).toBe(true);
  });
});

describe("assignAgentModel (/swap persistence)", () => {
  it("creates, updates with previous-key return, removes, and overlays correctly", () => {
    const localPath = join(dir, "models.local.yaml");
    expect(assignAgentModel("worker", "sonnet", localPath)).toBeNull(); // no prior
    expect(assignAgentModel("worker", "gemini-flash", localPath)).toBe("sonnet");
    // merged into resolution: local assignment wins
    const merged = loadModelCatalog(catalogPath, localPath)!;
    expect(merged.agents.worker.model).toBe("gemini-flash");
    // revert path: null removes the assignment
    expect(assignAgentModel("worker", null, localPath)).toBe("gemini-flash");
    const after = loadModelCatalog(catalogPath, localPath)!;
    expect(after.agents.worker).toBeUndefined();
  });
});

describe("validateCatalog (doctor-style audit)", () => {
  it("flags missing keys as errors, missing env vars as warnings", () => {
    const { errors, warnings } = validateCatalog(catalog, {} as NodeJS.ProcessEnv);
    expect(errors.some((e) => e.includes("no-such-key"))).toBe(true);
    // env-var warnings fire only for ASSIGNED entries (too-early → deepseek-flash)
    expect(warnings.some((w) => w.includes("TEST_DEEPSEEK_KEY"))).toBe(true);
    expect(warnings.some((w) => w.includes("TEST_GEMINI_KEY"))).toBe(false);
  });

  it("is quiet for a healthy catalog", () => {
    const healthy = loadModelCatalog(catalogPath)!;
    healthy.agents = { clerk: { model: "sonnet" } };
    const { errors } = validateCatalog(healthy, { TEST_GEMINI_KEY: "g" } as NodeJS.ProcessEnv);
    expect(errors).toEqual([]);
  });
});
