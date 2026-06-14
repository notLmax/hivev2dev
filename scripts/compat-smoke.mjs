#!/usr/bin/env node
/**
 * compat-smoke.mjs — WP3 pre-flight: probe Ollama Cloud's API surface for the
 * anthropic-compat runtime lane (04 §3; BASE-PIN decision 3).
 *
 * Discovers, empirically:
 *   1. model availability (GET /api/tags)
 *   2. Anthropic Messages endpoint (POST /v1/messages) — the shape the
 *      anthropic-compat runtime wants
 *   3. OpenAI chat endpoint (POST /v1/chat/completions) — the fallback shape
 *   4. tool calling on whichever chat surface works
 *   5. the known 400-quirk: an assistant turn with empty content in history
 *      (house-md hit this on kimi/deepseek via ollama — the WP3 normalizer
 *      must paper over it; this measures whether it still reproduces)
 *
 * Reads OLLAMA_API_KEY from the environment or .env. NEVER prints the key.
 *
 * Usage: node scripts/compat-smoke.mjs [--base https://ollama.com] [--model <tag>]
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const argValue = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const BASE = (argValue("--base") ?? "https://ollama.com").replace(/\/$/, "");

function loadKey() {
  if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY;
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    // ﻿ strip: PowerShell 5.1 writes UTF-8 with BOM.
    const m = readFileSync(envPath, "utf-8").replace(/^﻿/, "").match(/^OLLAMA_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  console.error("FAIL: OLLAMA_API_KEY not set (env or .env)");
  process.exit(1);
}
const KEY = loadKey();

const snip = (s, n = 400) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t.length > n ? t.slice(0, n) + ` …[${t.length} chars]` : t;
};

async function http(method, path, body, timeoutMs = 90_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${KEY}`,
        "x-api-key": KEY, // Anthropic-style auth header — harmless elsewhere
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const report = { base: BASE, results: {} };

// ── 1. Model discovery ───────────────────────────────────────────────────────
console.log(`\n═══ 1. Model discovery (${BASE}) ═══`);
let models = [];
for (const path of ["/api/tags", "/v1/models"]) {
  const r = await http("GET", path, undefined, 20_000);
  console.log(`GET ${path} → ${r.status || r.error}`);
  if (r.status === 200 && r.json) {
    const list = r.json.models ?? r.json.data ?? [];
    models = list.map((m) => m.name ?? m.model ?? m.id).filter(Boolean);
    console.log(`  ${models.length} models: ${snip(models.join(", "), 600)}`);
    report.results[path] = { status: 200, count: models.length };
    break;
  } else {
    console.log(`  ${snip(r.text ?? r.error, 200)}`);
    report.results[path] = { status: r.status, body: snip(r.text ?? r.error, 120) };
  }
}

const deepseekModels = models.filter((m) => /deepseek/i.test(m));
const MODEL =
  argValue("--model") ??
  deepseekModels.find((m) => /v3|chat/i.test(m)) ??
  deepseekModels[0] ??
  "deepseek-v3.1:671b";
console.log(`\nUsing model: ${MODEL}` + (deepseekModels.length ? ` (deepseek available: ${deepseekModels.join(", ")})` : " (no deepseek in discovery — trying anyway)"));

// ── 2. Anthropic Messages shape ──────────────────────────────────────────────
console.log(`\n═══ 2. Anthropic Messages endpoint ═══`);
const anth = await http("POST", "/v1/messages", {
  model: MODEL,
  max_tokens: 32,
  system: "Reply with exactly: OK",
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
});
console.log(`POST /v1/messages → ${anth.status || anth.error}`);
console.log(`  ${snip(anth.json ?? anth.text ?? anth.error)}`);
report.results.anthropicMessages = { status: anth.status, ok: anth.status === 200 };
const anthropicWorks = anth.status === 200 && anth.json?.content;

// ── 3. OpenAI chat shape ─────────────────────────────────────────────────────
console.log(`\n═══ 3. OpenAI chat endpoint ═══`);
const oai = await http("POST", "/v1/chat/completions", {
  model: MODEL,
  max_tokens: 32,
  messages: [
    { role: "system", content: "Reply with exactly: OK" },
    { role: "user", content: "Reply with exactly: OK" },
  ],
});
console.log(`POST /v1/chat/completions → ${oai.status || oai.error}`);
console.log(`  ${snip(oai.json ?? oai.text ?? oai.error)}`);
report.results.openaiChat = { status: oai.status, ok: oai.status === 200 };
const openaiWorks = oai.status === 200 && oai.json?.choices;

// ── 4. Tool calling on the preferred surface ─────────────────────────────────
console.log(`\n═══ 4. Tool calling ═══`);
if (anthropicWorks) {
  const tool = await http("POST", "/v1/messages", {
    model: MODEL,
    max_tokens: 256,
    tools: [
      {
        name: "get_weather",
        description: "Get current weather for a city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    messages: [{ role: "user", content: "Use the get_weather tool to check Toronto." }],
  });
  const toolUse = tool.json?.content?.find?.((b) => b.type === "tool_use");
  console.log(`Anthropic-style tools → ${tool.status} ${toolUse ? `tool_use ✓ (${toolUse.name}, input ${snip(toolUse.input, 80)})` : "no tool_use block"}`);
  if (!toolUse) console.log(`  ${snip(tool.json ?? tool.text)}`);
  report.results.anthropicTools = { status: tool.status, toolUse: Boolean(toolUse) };

  // ── 5. The empty-assistant-content quirk ──
  if (toolUse) {
    const quirk = await http("POST", "/v1/messages", {
      model: MODEL,
      max_tokens: 64,
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
      messages: [
        { role: "user", content: "Use the get_weather tool to check Toronto." },
        // Assistant turn with ONLY the tool_use block (no text) — the shape
        // that historically 400'd via ollama on deepseek/kimi.
        { role: "assistant", content: [{ type: "tool_use", id: toolUse.id ?? "tu_1", name: "get_weather", input: { city: "Toronto" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id ?? "tu_1", content: "12°C, clear" }] },
      ],
    });
    console.log(`Tool-result round-trip (empty-text assistant turn) → ${quirk.status} ${quirk.status === 200 ? "✓ no quirk" : "⚠ QUIRK REPRODUCED"}`);
    if (quirk.status !== 200) console.log(`  ${snip(quirk.json ?? quirk.text ?? quirk.error)}`);
    else console.log(`  ${snip(quirk.json?.content)}`);
    report.results.quirkRoundTrip = { status: quirk.status };
  }
} else if (openaiWorks) {
  console.log("Anthropic surface absent — WP3 lane falls back to openai-compat variant. (Tool test on OpenAI shape:)");
  const tool = await http("POST", "/v1/chat/completions", {
    model: MODEL,
    max_tokens: 256,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
    messages: [{ role: "user", content: "Use the get_weather tool to check Toronto." }],
  });
  const call = tool.json?.choices?.[0]?.message?.tool_calls?.[0];
  console.log(`OpenAI-style tools → ${tool.status} ${call ? `tool_call ✓ (${call.function?.name})` : "no tool_call"}`);
  if (!call) console.log(`  ${snip(tool.json ?? tool.text)}`);
  report.results.openaiTools = { status: tool.status, toolCall: Boolean(call) };
} else {
  console.log("Neither chat surface responded 200 — check key/base URL.");
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log(`\n═══ Verdict ═══`);
console.log(
  anthropicWorks
    ? `✓ ${BASE} speaks the Anthropic Messages format — the anthropic-compat runtime covers the Ollama lane as designed.`
    : openaiWorks
      ? `⚠ ${BASE} is OpenAI-compatible only — WP3 needs the openai-compat variant of the runtime for this lane.`
      : `✗ No usable chat surface found at ${BASE}.`
);
console.log(`Recommended models.yaml ollama-deepseek entry: id: ${MODEL}\n`);
