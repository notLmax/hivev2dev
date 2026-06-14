/**
 * basic-tools.ts
 *
 * Reimplements Anthropic SDK's built-in tools (Bash, Read, Write, Edit, Glob,
 * Grep) as Google ADK FunctionTool instances. The Google ADK ships no shell or
 * filesystem tools by default — Anthropic ships these for free, we rebuild
 * them here so a Gemini-backed agent has the same toolbelt as a Claude one.
 *
 * Working directory:
 *   Every tool receives `workingDir` via the factory closure. We NEVER call
 *   `process.chdir()` — that's a process-wide global that would corrupt every
 *   other agent (and async continuation) sharing the Node runtime. Bash gets
 *   `cwd: workingDir` on execFile; Read/Write/Edit resolve relative paths
 *   against `workingDir` explicitly.
 *
 *   See house-md LESSONS.md #10 for the post-mortem.
 */

import { execFile } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { FunctionTool } from "@google/adk";
import { z } from "zod/v3";

const execFileAsync = promisify(execFile);

interface ToolFactoryOptions {
  workingDir: string;
}

/** Resolve a path against the agent's working directory, never CWD. */
function resolvePath(p: string, workingDir: string): string {
  return isAbsolute(p) ? p : resolve(workingDir, p);
}

/** Per-session "have we read this file?" gate. Mirrors Anthropic's Write rule. */
const readTracker = new Map<string, Set<string>>();

function markRead(sessionId: string, path: string): void {
  if (!readTracker.has(sessionId)) readTracker.set(sessionId, new Set());
  readTracker.get(sessionId)!.add(path);
}

function hasRead(sessionId: string, path: string): boolean {
  return readTracker.get(sessionId)?.has(path) ?? false;
}

export function createBasicTools(options: ToolFactoryOptions): FunctionTool[] {
  const { workingDir } = options;
  // Single shared session id per-runtime instance (per-agent). The read tracker
  // is keyed by it so two agents in the same process can't trample each other.
  const sessionId = `${workingDir}:${process.pid}`;

  // ── Bash ────────────────────────────────────────────────────────────
  const bash = new FunctionTool({
    name: "Bash",
    description:
      "Execute a bash command. Shell state does NOT persist between calls — " +
      "chain dependent commands with && in a single call. Use absolute paths " +
      "or prefix with `cd <dir> &&`. Output is stdout+stderr+exit code.",
    parameters: z.object({
      command: z.string().describe("The bash command to execute."),
      description: z
        .string()
        .optional()
        .describe("5-10 word description of what this does."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in ms, max 600000. Defaults to 120000."),
    }),
    execute: async ({ command, timeout }) => {
      const ms = Math.min(timeout ?? 120_000, 600_000);
      // Hard cap on what we hand back to the model. Anything bigger gets
      // persisted in the session forever (SQLite events table) and replayed
      // on every turn — a single un-piped `find /` could 10x context.
      const HARD_CAP = 16 * 1024; // 16 KB stdout + 16 KB stderr
      const trimTo = (s: string, n: number) =>
        s.length > n
          ? s.slice(0, n) + `\n[... truncated, ${s.length - n} more chars]`
          : s;
      try {
        const { stdout, stderr } = await execFileAsync(
          "/bin/bash",
          ["-c", command],
          { cwd: workingDir, timeout: ms, maxBuffer: 10 * 1024 * 1024 },
        );
        return {
          stdout: trimTo(stdout, HARD_CAP),
          stderr: trimTo(stderr, HARD_CAP),
          exitCode: 0,
        };
      } catch (err: any) {
        return {
          stdout: trimTo(err.stdout?.toString() ?? "", HARD_CAP),
          stderr: trimTo(
            err.stderr?.toString() ?? String(err.message ?? err),
            HARD_CAP,
          ),
          exitCode: err.code ?? 1,
        };
      }
    },
  });

  // ── Read ────────────────────────────────────────────────────────────
  const read = new FunctionTool({
    name: "Read",
    description:
      "Read a file. Returns cat -n style numbered lines. Supports offset/limit " +
      "for partial reads of large files. Must Read before Write.",
    parameters: z.object({
      file_path: z.string().describe("Absolute or working-dir relative path."),
      offset: z
        .number()
        .optional()
        .describe("0-indexed line to start at. Default 0."),
      limit: z
        .number()
        .optional()
        .describe("Max lines to return. Default 2000."),
    }),
    execute: async ({ file_path, offset = 0, limit = 2000 }) => {
      const path = resolvePath(file_path, workingDir);
      if (!existsSync(path)) return { error: `File does not exist: ${path}` };
      try {
        const raw = readFileSync(path, "utf-8");
        const lines = raw.split("\n");
        const slice = lines.slice(offset, offset + limit);
        const numbered = slice
          .map((line, i) => `${offset + i + 1}\t${line}`)
          .join("\n");
        markRead(sessionId, path);
        return { content: numbered, total_lines: lines.length };
      } catch (err: any) {
        return { error: String(err.message ?? err) };
      }
    },
  });

  // ── Write ───────────────────────────────────────────────────────────
  const write = new FunctionTool({
    name: "Write",
    description:
      "Write or overwrite a file. For existing files, you MUST Read first. " +
      "Use Edit for partial modifications.",
    parameters: z.object({
      file_path: z.string(),
      content: z.string(),
    }),
    execute: async ({ file_path, content }) => {
      const path = resolvePath(file_path, workingDir);
      if (existsSync(path) && !hasRead(sessionId, path)) {
        return {
          error:
            "Refusing to overwrite existing file without prior Read. " +
            "Call Read on this path first.",
        };
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf-8");
        markRead(sessionId, path);
        return { ok: true, path };
      } catch (err: any) {
        return { error: String(err.message ?? err) };
      }
    },
  });

  // ── Edit ────────────────────────────────────────────────────────────
  const edit = new FunctionTool({
    name: "Edit",
    description:
      "Exact-string replace in a file. Read first. `old_string` must be unique " +
      "in the file unless `replace_all: true`.",
    parameters: z.object({
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all }) => {
      const path = resolvePath(file_path, workingDir);
      if (!existsSync(path)) return { error: `File does not exist: ${path}` };
      if (!hasRead(sessionId, path)) {
        return { error: "Read the file before editing it." };
      }
      const before = readFileSync(path, "utf-8");
      let after: string;
      if (replace_all) {
        after = before.split(old_string).join(new_string);
        if (after === before)
          return { error: "old_string not found in file." };
      } else {
        const count = before.split(old_string).length - 1;
        if (count === 0) return { error: "old_string not found in file." };
        if (count > 1)
          return {
            error:
              `old_string occurs ${count} times. ` +
              "Provide more context to make it unique, or set replace_all: true.",
          };
        after = before.replace(old_string, new_string);
      }
      writeFileSync(path, after, "utf-8");
      return { ok: true, path, replacements: replace_all ? "all" : 1 };
    },
  });

  // ── Glob ────────────────────────────────────────────────────────────
  const glob = new FunctionTool({
    name: "Glob",
    description:
      "Find files matching a glob pattern. Returns paths sorted by mtime " +
      "(most recent first). Defaults to a 250-path cap — pass `head_limit` " +
      "higher if you genuinely need more. Use a SPECIFIC pattern; broad " +
      "patterns like '**/*' on big trees waste context permanently.",
    parameters: z.object({
      pattern: z.string().describe('Glob pattern, e.g. "**/*.ts".'),
      path: z
        .string()
        .optional()
        .describe("Base path to search from. Defaults to working dir."),
      head_limit: z
        .number()
        .optional()
        .describe("Max paths to return. Default 250. Pass 0 for unlimited."),
    }),
    execute: async ({ pattern, path, head_limit }) => {
      const base = path ? resolvePath(path, workingDir) : workingDir;
      const cap = head_limit === 0 ? Infinity : head_limit ?? 250;
      try {
        const matches = await fg(pattern, {
          cwd: base,
          absolute: true,
          dot: false,
          onlyFiles: true,
        });
        const withMtime = matches
          .map((p) => {
            try {
              return { p, mtime: statSync(p).mtimeMs };
            } catch {
              return { p, mtime: 0 };
            }
          })
          .sort((a, b) => b.mtime - a.mtime)
          .map((x) => x.p);
        const total = withMtime.length;
        const limited = total > cap ? withMtime.slice(0, cap) : withMtime;
        return {
          matches: limited,
          count: limited.length,
          total,
          truncated: total > cap,
        };
      } catch (err: any) {
        return { error: String(err.message ?? err) };
      }
    },
  });

  // ── Grep ────────────────────────────────────────────────────────────
  // Shells out to rg. Replicates the most-used parameter surface of
  // Anthropic's Grep tool. Falls back to BSD grep if rg is missing.
  const grep = new FunctionTool({
    name: "Grep",
    description:
      "Search file contents with a regex (ripgrep). Use `glob` to filter " +
      "files (e.g. '*.ts'). output_mode 'content' shows matches, " +
      "'files_with_matches' just lists paths.",
    parameters: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
      output_mode: z
        .enum(["content", "files_with_matches", "count"])
        .optional(),
      case_insensitive: z.boolean().optional(),
      head_limit: z.number().optional(),
    }),
    execute: async ({
      pattern,
      path,
      glob: globPattern,
      output_mode = "files_with_matches",
      case_insensitive,
      head_limit,
    }) => {
      const args: string[] = [];
      if (case_insensitive) args.push("-i");
      if (globPattern) args.push("--glob", globPattern);
      if (output_mode === "files_with_matches") args.push("-l");
      else if (output_mode === "count") args.push("-c");
      else args.push("-n");
      args.push("--", pattern);
      if (path) args.push(resolvePath(path, workingDir));
      try {
        const { stdout } = await execFileAsync("rg", args, {
          cwd: workingDir,
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const lines = stdout.split("\n").filter(Boolean);
        const limited = head_limit ? lines.slice(0, head_limit) : lines;
        return { matches: limited, count: limited.length };
      } catch (err: any) {
        // rg exits 1 on no matches — that's not an error.
        if (err.code === 1) return { matches: [], count: 0 };
        return { error: String(err.message ?? err) };
      }
    },
  });

  return [bash, read, write, edit, glob, grep];
}
