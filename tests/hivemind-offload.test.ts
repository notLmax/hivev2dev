/**
 * Hivemind large-message offload (audit must-fix 9).
 * Short messages pass through unchanged; oversized ones are written to a file
 * and replaced with a short pointer stub the recipient can Read.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { maybeOffloadHivemind, HIVEMIND_OFFLOAD_THRESHOLD } from "../src/tools/messaging.js";

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hive-exchange-"));
  saved = process.env.HIVE_EXCHANGE_DIR;
  process.env.HIVE_EXCHANGE_DIR = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.HIVE_EXCHANGE_DIR;
  else process.env.HIVE_EXCHANGE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("maybeOffloadHivemind", () => {
  it("passes a short message through unchanged (no file written)", () => {
    const msg = "quick question: what's the status of the deploy?";
    const out = maybeOffloadHivemind("alpha", "beta", msg);
    expect(out).toBe(msg);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("offloads an oversized message to a file and returns a short stub", () => {
    const big = "x".repeat(HIVEMIND_OFFLOAD_THRESHOLD + 500);
    const out = maybeOffloadHivemind("alpha", "beta", big);

    // Stub is short (well under Discord's 2000-char limit) and points at the file.
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain("offloaded to a file");
    expect(out).toContain("Read that file");

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^alpha-beta-.*\.md$/);
    // The full content is preserved in the file.
    expect(readFileSync(join(dir, files[0]), "utf-8")).toContain(big);
  });

  it("is exactly at-threshold inclusive (boundary not offloaded)", () => {
    const exact = "y".repeat(HIVEMIND_OFFLOAD_THRESHOLD);
    const out = maybeOffloadHivemind("a", "b", exact);
    expect(out).toBe(exact);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
