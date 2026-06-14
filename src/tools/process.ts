/**
 * process.ts
 * Manage background processes — start, poll, log, kill.
 */

import { spawn, ChildProcess } from "child_process";

interface ManagedProcess {
  id: string;
  command: string;
  pid: number;
  startedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
  logs: string[];
}

const processes = new Map<string, { proc: ChildProcess; meta: ManagedProcess }>();
const MAX_LOG_LINES = 500;

/**
 * Starts a background process.
 */
export function processStart(command: string, args: string[] = []): ManagedProcess {
  const id = `proc-${Date.now()}`;

  // Join command + args into a single shell string to avoid DEP0190 warning
  const fullCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;
  const proc = spawn(fullCommand, [], {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  const meta: ManagedProcess = {
    id,
    command: `${command} ${args.join(" ")}`.trim(),
    pid: proc.pid || 0,
    startedAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    logs: [],
  };

  // Capture stdout
  proc.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      meta.logs.push(`[out] ${line}`);
      if (meta.logs.length > MAX_LOG_LINES) meta.logs.shift();
    }
  });

  // Capture stderr
  proc.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      meta.logs.push(`[err] ${line}`);
      if (meta.logs.length > MAX_LOG_LINES) meta.logs.shift();
    }
  });

  // Track exit
  proc.on("exit", (code) => {
    meta.status = "exited";
    meta.exitCode = code;
  });

  processes.set(id, { proc, meta });
  return meta;
}

/**
 * Lists all managed processes.
 */
export function processList(): ManagedProcess[] {
  return Array.from(processes.values()).map((p) => p.meta);
}

/**
 * Gets recent logs from a process.
 */
export function processLogs(id: string, lines: number = 50): string[] {
  const entry = processes.get(id);
  if (!entry) return [`Process ${id} not found`];
  return entry.meta.logs.slice(-lines);
}

/**
 * Kills a background process.
 */
export function processKill(id: string): boolean {
  const entry = processes.get(id);
  if (!entry) return false;

  try {
    entry.proc.kill("SIGTERM");
    entry.meta.status = "exited";
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends input to a process's stdin.
 */
export function processSendKeys(id: string, input: string): boolean {
  const entry = processes.get(id);
  if (!entry || !entry.proc.stdin) return false;

  try {
    entry.proc.stdin.write(input);
    return true;
  } catch {
    return false;
  }
}
