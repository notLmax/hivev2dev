/**
 * builtin-tools.ts — Bash/Read/Write/Edit/Glob/Grep/WebFetch for runtimes
 * that own their loop. Logic adapted from the ADK lane's FunctionTools
 * (google-adk/tools/basic-tools.ts) with the same hygiene caps.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import fg from "fast-glob";
import type { SharedTool, SharedToolResult } from "./tool-registry.js";

const OUTPUT_HARD_CAP = 16 * 1024; // 16 KB — Queen Bee hygiene cap (04 §4.8)
const GLOB_DEFAULT_CAP = 250;
const GREP_MATCH_CAP = 100;
const BASH_TIMEOUT_MS = 120_000;
const WEBFETCH_TIMEOUT_MS = 30_000;

function capTail(s: string, cap: number = OUTPUT_HARD_CAP): string {
  if (s.length <= cap) return s;
  return `[... truncated, ${s.length - cap} more chars]\n` + s.slice(-cap);
}

function capHead(s: string, cap: number = OUTPUT_HARD_CAP): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n[... truncated, ${s.length - cap} more chars]`;
}

function resolvePath(p: string, workingDir: string): string {
  return isAbsolute(p) ? p : join(workingDir, p);
}

function ok(text: string): SharedToolResult {
  return { text };
}
function err(text: string): SharedToolResult {
  return { text, isError: true };
}

export function createBuiltinTools(): SharedTool[] {
  return [
    {
      name: "Bash",
      description:
        "Execute a shell command and return stdout/stderr (each capped at 16 KB, tail kept). " +
        "120s timeout. Use for git, npm, curl, tmux, and anything without a native tool.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute" },
        },
        required: ["command"],
      },
      async execute(args, ctx) {
        const result = spawnSync(String(args.command ?? ""), {
          shell: true,
          cwd: ctx.workingDir,
          encoding: "utf-8",
          timeout: BASH_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        });
        const stdout = capTail(result.stdout ?? "");
        const stderr = capTail(result.stderr ?? "");
        const code = result.status;
        if (result.error) return err(`Command failed to spawn: ${result.error.message}`);
        const body = [stdout, stderr ? `[stderr]\n${stderr}` : ""].filter(Boolean).join("\n");
        if (code !== 0) return err(`Exit code ${code}\n${body}`);
        return ok(body || "(no output)");
      },
    },
    {
      name: "Read",
      description:
        "Read a file. Supports offset (1-based start line) and limit (line count, default 2000). " +
        "Output is capped at 16 KB — re-read with offset for more.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file (absolute, or relative to the working dir)" },
          offset: { type: "number", description: "1-based line to start from" },
          limit: { type: "number", description: "Max lines to return (default 2000)" },
        },
        required: ["file_path"],
      },
      async execute(args, ctx) {
        const path = resolvePath(String(args.file_path ?? ""), ctx.workingDir);
        if (!existsSync(path)) return err(`File not found: ${path}`);
        const lines = readFileSync(path, "utf-8").split("\n");
        const offset = Math.max(1, Number(args.offset ?? 1));
        const limit = Math.max(1, Number(args.limit ?? 2000));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
        return ok(capHead(numbered) || "(empty file)");
      },
    },
    {
      name: "Write",
      description: "Write content to a file (creates parent directories; overwrites existing content).",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to write" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["file_path", "content"],
      },
      async execute(args, ctx) {
        const path = resolvePath(String(args.file_path ?? ""), ctx.workingDir);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(args.content ?? ""), "utf-8");
        return ok(`Wrote ${Buffer.byteLength(String(args.content ?? ""), "utf-8")} bytes to ${path}`);
      },
    },
    {
      name: "Edit",
      description:
        "Exact string replacement in a file. old_string must match exactly and be unique " +
        "(or set replace_all: true to replace every occurrence).",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to edit" },
          old_string: { type: "string", description: "Exact text to find" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
      async execute(args, ctx) {
        const path = resolvePath(String(args.file_path ?? ""), ctx.workingDir);
        if (!existsSync(path)) return err(`File not found: ${path}`);
        const content = readFileSync(path, "utf-8");
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        if (!oldStr) return err("old_string must not be empty");
        const count = content.split(oldStr).length - 1;
        if (count === 0) return err("old_string not found in file");
        if (count > 1 && !args.replace_all) {
          return err(`old_string matches ${count} times — make it unique or set replace_all: true`);
        }
        const updated = args.replace_all
          ? content.split(oldStr).join(newStr)
          : content.replace(oldStr, newStr);
        writeFileSync(path, updated, "utf-8");
        return ok(`Replaced ${args.replace_all ? count : 1} occurrence(s) in ${path}`);
      },
    },
    {
      name: "Glob",
      description: `Find files matching a glob pattern (e.g. "src/**/*.ts"). Returns up to ${GLOB_DEFAULT_CAP} paths.`,
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Directory to search (default: working dir)" },
          head_limit: { type: "number", description: `Max paths (default ${GLOB_DEFAULT_CAP}, 0 = unlimited)` },
        },
        required: ["pattern"],
      },
      async execute(args, ctx) {
        const cwd = resolvePath(String(args.path ?? "."), ctx.workingDir);
        const capRaw = Number(args.head_limit ?? GLOB_DEFAULT_CAP);
        const cap = capRaw === 0 ? Infinity : capRaw;
        const entries = await fg(String(args.pattern ?? ""), {
          cwd,
          dot: false,
          onlyFiles: true,
          ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
        });
        const capped = entries.slice(0, cap === Infinity ? undefined : cap);
        const note = entries.length > capped.length ? `\n[... ${entries.length - capped.length} more paths]` : "";
        return ok(capped.length ? capped.join("\n") + note : "(no matches)");
      },
    },
    {
      name: "Grep",
      description: `Search file contents with a regex. Returns up to ${GREP_MATCH_CAP} matching lines as path:line:text.`,
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression" },
          path: { type: "string", description: "Directory or file to search (default: working dir)" },
          glob: { type: "string", description: 'File filter glob (default "**/*")' },
        },
        required: ["pattern"],
      },
      async execute(args, ctx) {
        let regex: RegExp;
        try {
          regex = new RegExp(String(args.pattern ?? ""));
        } catch (e) {
          return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
        }
        const root = resolvePath(String(args.path ?? "."), ctx.workingDir);
        const files = statSync(root, { throwIfNoEntry: false })?.isFile()
          ? [root]
          : (
              await fg(String(args.glob ?? "**/*"), {
                cwd: root,
                dot: false,
                onlyFiles: true,
                ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
              })
            ).map((f) => join(root, f));
        const matches: string[] = [];
        for (const file of files) {
          if (matches.length >= GREP_MATCH_CAP) break;
          let content: string;
          try {
            if ((statSync(file).size ?? 0) > 2 * 1024 * 1024) continue; // skip huge files
            content = readFileSync(file, "utf-8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && matches.length < GREP_MATCH_CAP; i++) {
            if (regex.test(lines[i])) matches.push(`${file}:${i + 1}:${lines[i].slice(0, 300)}`);
          }
        }
        const body = matches.join("\n");
        return ok(capHead(body) || "(no matches)");
      },
    },
    {
      name: "WebFetch",
      description: "Fetch a URL and return its text content (16 KB cap, 30s timeout).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
        },
        required: ["url"],
      },
      async execute(args) {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) return err("Only http(s) URLs are supported");
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), WEBFETCH_TIMEOUT_MS);
        try {
          const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
          const text = await res.text();
          return ok(`HTTP ${res.status}\n${capHead(text)}`);
        } catch (e) {
          return err(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  ];
}
