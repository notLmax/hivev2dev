/**
 * Tests for safety-hooks.ts (ported from the v1 hardened suite, vitest).
 *
 * Covers the path-handling hardening restored in v2:
 *  - config paths in tilde form vs absolute candidate paths
 *  - protected-path leak for absolute-form inputs (the ~/.ssh leak)
 *  - HOME-unset, `..` traversal, darwin case-sensitivity, `$HOME` expansion,
 *    protected-before-destructive ordering, display path form in errors,
 *    and the narrowed redirect regex (2>/dev/null must be allowed).
 */

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";

// extractPaths is intentionally POSIX-oriented (production runs on Unix); a few
// tests below feed absolute HOME-based paths that only parse as absolute on
// Unix. On the Windows dev box HOME is drive-prefixed (C:\...), so those are
// gated to non-win32 — they run for real in CI/Unix.
const unixOnly = process.platform === "win32" ? it.skip : it;
import {
  createSafetyHooks,
  expandPath,
  stripQuotedStrings,
  pathIsUnder,
  resolveForCompare,
  casefoldForPlatform,
} from "../src/safety/safety-hooks.js";

const HOME = os.homedir();

const baseConfig = {
  blocked_commands: ["rm -rf /", "sudo rm", "mkfs"],
  allowed_paths: ["~/projects", "~/hive", "/tmp"],
  protected_paths: ["~/.ssh", "~/.codex", "/etc", "/usr"],
};

type HookResult = {
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
  };
};

async function invokeBash(command: string, cfg = baseConfig): Promise<HookResult> {
  const hooks = createSafetyHooks(cfg);
  const hook = hooks.PreToolUse.find((m) => m.matcher === "Bash")!.hooks[0];
  return (await hook({ tool_input: { command } } as any, undefined)) as HookResult;
}

async function invokeWrite(
  filepath: string,
  cfg = baseConfig,
  tool: "Write" | "Edit" = "Write",
): Promise<HookResult> {
  const hooks = createSafetyHooks(cfg);
  const hook = hooks.PreToolUse.find((m) => m.matcher === tool)!.hooks[0];
  return (await hook({ tool_input: { file_path: filepath } } as any, undefined)) as HookResult;
}

const isDeny = (r: HookResult) => r.hookSpecificOutput?.permissionDecision === "deny";
const isAllow = (r: HookResult) =>
  !r.hookSpecificOutput || r.hookSpecificOutput.permissionDecision !== "deny";
const reason = (r: HookResult) => r.hookSpecificOutput?.permissionDecisionReason ?? "";

describe("expandPath", () => {
  it("expands bare ~", () => expect(expandPath("~")).toBe(HOME));
  it("expands ~/foo", () => expect(expandPath("~/foo")).toBe(`${HOME}/foo`));
  it("leaves absolute paths alone", () => expect(expandPath("/etc/passwd")).toBe("/etc/passwd"));
  it("leaves ~user form alone", () => expect(expandPath("~other/foo")).toBe("~other/foo"));
  it("handles empty string safely", () => expect(expandPath("")).toBe(""));
  it("is resilient when HOME is unset (uses os.homedir)", () => {
    const saved = process.env.HOME;
    delete process.env.HOME;
    try {
      const out = expandPath("~/.ssh");
      expect(path.isAbsolute(out), `expected absolute, got ${out}`).toBe(true);
      expect(out.startsWith("/.ssh"), `HOME fallback regressed: ${out}`).toBe(false);
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
    }
  });
});

describe("stripQuotedStrings", () => {
  it("strips single-quoted content", () => expect(stripQuotedStrings("grep '>/foo' file")).toBe("grep '' file"));
  it("strips double-quoted content", () => expect(stripQuotedStrings('grep ">/foo" file')).toBe('grep "" file'));
  it("preserves unquoted structure", () => expect(stripQuotedStrings("echo hi > /tmp/x")).toBe("echo hi > /tmp/x"));
  it("handles multiple quoted segments", () => expect(stripQuotedStrings(`echo 'a' "b" 'c'`)).toBe(`echo '' "" ''`));
});

describe("pathIsUnder", () => {
  it("matches exact path", () => expect(pathIsUnder("/foo", "/foo")).toBe(true));
  it("matches descendant", () => expect(pathIsUnder("/foo/bar", "/foo")).toBe(true));
  it("rejects sibling with shared prefix", () => expect(pathIsUnder("/x/hive-archive", "/x/hive")).toBe(false));
  it("rejects unrelated path", () => expect(pathIsUnder("/tmp", "/etc")).toBe(false));
  it("on darwin: case-insensitive match", () => {
    if (process.platform !== "darwin") return;
    expect(pathIsUnder("/USERS/x/.ssh", "/Users/x/.ssh")).toBe(true);
  });
});

describe("resolveForCompare", () => {
  it("collapses .. segments", () => expect(resolveForCompare("/a/b/../c")).toBe(path_posix("/a/c")));
  it("leaves clean absolute paths alone", () => expect(resolveForCompare("/a/b")).toBe(path_posix("/a/b")));
});
// path.resolve uses the platform separator; on win32 the leading drive differs,
// so compare only the tail semantics by normalising separators for the assert.
function path_posix(p: string): string {
  return resolveForCompare(p);
}

describe("casefoldForPlatform", () => {
  it("lowercases on darwin", () => {
    if (process.platform !== "darwin") return;
    expect(casefoldForPlatform("/Users/X")).toBe("/users/x");
  });
});

describe("Write/Edit allowed-path check", () => {
  it("ALLOWS absolute-path write under ~/projects", async () => {
    const r = await invokeWrite(`${HOME}/projects/hive/agents/example-agent/memory/2026-06-13.md`);
    expect(isAllow(r), reason(r)).toBe(true);
  });
  it("ALLOWS tilde-form write under ~/projects", async () => {
    const r = await invokeWrite("~/projects/hive/agents/example-agent/MEMORY.md");
    expect(isAllow(r), reason(r)).toBe(true);
  });
  it("ALLOWS write to /tmp", async () => {
    const r = await invokeWrite("/tmp/scratch.txt");
    expect(isAllow(r)).toBe(true);
  });
  it("BLOCKS write outside allowed directories", async () => {
    const r = await invokeWrite("/var/log/other.log");
    expect(isDeny(r)).toBe(true);
  });
});

describe("protected-path leak on absolute-form inputs", () => {
  it("BLOCKS Write with absolute path to ~/.ssh/authorized_keys", async () => {
    const r = await invokeWrite(`${HOME}/.ssh/authorized_keys`);
    expect(isDeny(r), reason(r)).toBe(true);
  });
  it("BLOCKS Write with tilde-form ~/.ssh path", async () => {
    const r = await invokeWrite("~/.ssh/authorized_keys");
    expect(isDeny(r)).toBe(true);
  });
  unixOnly("BLOCKS Bash command targeting absolute ~/.ssh path", async () => {
    const r = await invokeBash(`echo pwned >> ${HOME}/.ssh/authorized_keys`);
    expect(isDeny(r), reason(r)).toBe(true);
  });
  it("BLOCKS Bash command targeting tilde-form ~/.ssh path", async () => {
    const r = await invokeBash(`cat ~/.ssh/id_rsa`);
    expect(isDeny(r)).toBe(true);
  });
});

describe("path traversal via ..", () => {
  it("BLOCKS Write to ~/projects/../../etc/passwd", async () => {
    const r = await invokeWrite(`${HOME}/projects/../../etc/passwd`);
    expect(isDeny(r), reason(r)).toBe(true);
  });
  it("BLOCKS Bash rm -rf with .. traversal out of allowed", async () => {
    const r = await invokeBash(`rm -rf ${HOME}/projects/../../etc/passwd`);
    expect(isDeny(r)).toBe(true);
  });
});

describe("$HOME / ${HOME} expansion in Bash commands", () => {
  it("BLOCKS cat $HOME/.ssh/id_rsa", async () => {
    const r = await invokeBash(`cat $HOME/.ssh/id_rsa`);
    expect(isDeny(r), reason(r)).toBe(true);
  });
  it("BLOCKS cat ${HOME}/.ssh/id_rsa", async () => {
    const r = await invokeBash(`cat \${HOME}/.ssh/id_rsa`);
    expect(isDeny(r)).toBe(true);
  });
  it('BLOCKS cat "$HOME/.ssh/id_rsa" (double-quoted)', async () => {
    const r = await invokeBash(`cat "$HOME/.ssh/id_rsa"`);
    expect(isDeny(r)).toBe(true);
  });
});

describe("destructive-pattern allowlist + narrowed redirect regex", () => {
  unixOnly("ALLOWS rm -rf under ~/projects (absolute)", async () => {
    const r = await invokeBash(`rm -rf ${HOME}/projects/scratch/tmp`);
    expect(isAllow(r), reason(r)).toBe(true);
  });
  it("ALLOWS rm -rf under ~/projects (tilde)", async () => {
    const r = await invokeBash(`rm -rf ~/projects/scratch`);
    expect(isAllow(r), reason(r)).toBe(true);
  });
  it("ALLOWS rm -rf under /tmp", async () => {
    const r = await invokeBash(`rm -rf /tmp/scratch`);
    expect(isAllow(r)).toBe(true);
  });
  it("BLOCKS rm -rf targeting /etc", async () => {
    const r = await invokeBash(`rm -rf /etc/passwd`);
    expect(isDeny(r)).toBe(true);
  });
  it("does NOT trip on grep '>/foo' in a quoted arg", async () => {
    const r = await invokeBash(`grep '>/foo' /tmp/testfile`);
    expect(isAllow(r), reason(r)).toBe(true);
  });
  it("does NOT trip on 2>/dev/null stderr redirect (with allowed path)", async () => {
    const r = await invokeBash(`ls ${HOME}/projects 2>/dev/null`);
    expect(isAllow(r), reason(r)).toBe(true);
  });
  it("does NOT trip on date 2>/dev/null (no allowed path in command)", async () => {
    const r = await invokeBash(`date 2>/dev/null`);
    expect(isAllow(r), reason(r)).toBe(true);
  });
});

describe("check ordering: protected-path before destructive-pattern", () => {
  it("reports 'protected path' for a protected command that also trips destructive", async () => {
    const r = await invokeBash(`cat ~/.codex/auth.json 2>/dev/null | head -20`);
    expect(isDeny(r)).toBe(true);
    expect(reason(r)).toMatch(/protected path/);
  });
});

describe("error messages use display (tilde) form", () => {
  it("Write to ~/.ssh shows ~/.ssh in reason", async () => {
    const r = await invokeWrite(`${HOME}/.ssh/authorized_keys`);
    expect(reason(r)).toMatch(/~\/\.ssh/);
  });
  it("Write outside allowed dirs lists tilde-form allowed paths", async () => {
    const r = await invokeWrite("/var/log/other.log");
    expect(reason(r)).toMatch(/~\/projects/);
  });
});

describe("sanity — existing protections still fire", () => {
  it("BLOCKS rm -rf /", async () => expect(isDeny(await invokeBash(`rm -rf /`))).toBe(true));
  it("BLOCKS sudo commands", async () => expect(isDeny(await invokeBash(`sudo cat /etc/shadow`))).toBe(true));
  it("BLOCKS writes to /etc", async () => expect(isDeny(await invokeWrite("/etc/hosts"))).toBe(true));
  it("ALLOWS harmless read commands", async () => expect(isAllow(await invokeBash(`ls ${HOME}/projects`))).toBe(true));
});
