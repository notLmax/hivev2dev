/**
 * codex-tasks.ts
 *
 * Registry for long-running Codex tasks launched by coding agents.
 *
 * Flow:
 *   1. Agent calls LaunchCodexTask → registerTask() + tmux spawn
 *   2. Background watcher in bot.ts polls listTasks(agent="...", status="running")
 *   3. On tmux session terminate → markCompleted(taskId, output) + wake the agent
 *   4. Agent processes the wake, takes action per its Completion Protocol
 *
 * Persisted to data/codex-tasks.json so PM2 restart doesn't drop in-flight work.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

const TASKS_FILE = join(process.cwd(), "data", "codex-tasks.json");

export type TaskStatus = "running" | "completed" | "failed" | "timeout";

export interface CodexTask {
  taskId: string;
  agent: string;
  channel: string;
  taskName: string;
  projectDir: string;
  promptFile: string;
  sessionName: string;
  startedAt: string;            // ISO
  status: TaskStatus;
  waveContext?: string;         // optional — "Wave 3 of 5"
  onCompletePrompt?: string;    // optional override for completion wake
  baseSha?: string;             // git HEAD at launch time, for diffs
  completedAt?: string;
  outputTail?: string;          // captured at completion
}

function ensureTasksFile(): void {
  const dir = dirname(TASKS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(TASKS_FILE)) writeFileSync(TASKS_FILE, JSON.stringify({ tasks: [] }, null, 2));
}

function loadAll(): CodexTask[] {
  ensureTasksFile();
  try {
    const raw = readFileSync(TASKS_FILE, "utf-8");
    const data = JSON.parse(raw) as { tasks: CodexTask[] };
    return data.tasks || [];
  } catch {
    return [];
  }
}

function saveAll(tasks: CodexTask[]): void {
  ensureTasksFile();
  writeFileSync(TASKS_FILE, JSON.stringify({ tasks }, null, 2));
}

function newTaskId(): string {
  return "task-" + randomBytes(4).toString("hex");
}

function newSessionName(taskName: string, taskId: string): string {
  // tmux session names must be safe — replace anything non-alphanum with -
  const safe = taskName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30);
  return `codex-${safe}-${taskId}`;
}

/** Register a task and launch it in tmux. Returns the task record. */
export function launchTask(input: {
  agent: string;
  channel: string;
  taskName: string;
  projectDir: string;
  promptFile: string;
  waveContext?: string;
  onCompletePrompt?: string;
}): CodexTask {
  if (!existsSync(input.projectDir)) {
    throw new Error(`projectDir does not exist: ${input.projectDir}`);
  }
  const fullPromptPath = join(input.projectDir, input.promptFile);
  if (!existsSync(fullPromptPath)) {
    throw new Error(`promptFile does not exist: ${fullPromptPath}`);
  }

  // Capture git HEAD for later diffs (best-effort).
  let baseSha: string | undefined;
  try {
    baseSha = execSync(`git -C "${input.projectDir}" rev-parse HEAD`, { encoding: "utf-8" }).trim();
  } catch {
    // Not a git repo, or git failed — proceed without baseSha.
  }

  const taskId = newTaskId();
  const sessionName = newSessionName(input.taskName, taskId);

  // Launch via tmux. Single command line to avoid shell-escape weirdness.
  // We use bash -lc to ensure the user's PATH and env are loaded (Codex relies on them).
  const tmuxCmd = `tmux new-session -d -s ${sessionName} ` +
    `bash -lc 'cd ${shellEscape(input.projectDir)} && ` +
    `codex exec --yolo "$(cat ${shellEscape(input.promptFile)})" ` +
    `2>&1 | tee /tmp/${sessionName}.log'`;

  const result = spawnSync("bash", ["-lc", tmuxCmd], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`tmux launch failed: ${result.stderr || result.stdout || "unknown error"}`);
  }

  const task: CodexTask = {
    taskId,
    agent: input.agent,
    channel: input.channel,
    taskName: input.taskName,
    projectDir: input.projectDir,
    promptFile: input.promptFile,
    sessionName,
    startedAt: new Date().toISOString(),
    status: "running",
    waveContext: input.waveContext,
    onCompletePrompt: input.onCompletePrompt,
    baseSha,
  };

  const all = loadAll();
  all.push(task);
  saveAll(all);

  return task;
}

/** List tasks, optionally filtered by agent and/or status. */
export function listTasks(filter?: { agent?: string; status?: TaskStatus }): CodexTask[] {
  const all = loadAll();
  return all.filter((t) => {
    if (filter?.agent && t.agent !== filter.agent) return false;
    if (filter?.status && t.status !== filter.status) return false;
    return true;
  });
}

/** Get a single task by id. */
export function getTask(taskId: string): CodexTask | undefined {
  return loadAll().find((t) => t.taskId === taskId);
}

/** Update a task's status + completion details. */
export function updateTask(taskId: string, patch: Partial<CodexTask>): CodexTask | undefined {
  const all = loadAll();
  const idx = all.findIndex((t) => t.taskId === taskId);
  if (idx === -1) return undefined;
  all[idx] = { ...all[idx], ...patch };
  saveAll(all);
  return all[idx];
}

/** Returns true if the tmux session is still alive. */
export function isSessionAlive(sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { encoding: "utf-8" });
  return result.status === 0;
}

/** Capture the last N lines of a tmux session's output. */
export function captureOutput(sessionName: string, lines: number = 100): string {
  // -p prints to stdout; -S -<lines> = scrollback start at -lines from current
  const result = spawnSync("tmux", ["capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    // Session may have died; try the saved log file fallback.
    try {
      const log = readFileSync(`/tmp/${sessionName}.log`, "utf-8");
      const allLines = log.split("\n");
      return allLines.slice(-lines).join("\n");
    } catch {
      return "(no output captured)";
    }
  }
  return result.stdout;
}

/** Get the diff since baseSha (returns short stat + truncated full diff). */
export function getDiffSummary(projectDir: string, baseSha: string | undefined, maxChars: number = 8000): string {
  if (!baseSha) return "(no baseSha — diff unavailable)";
  try {
    const stat = execSync(`git -C "${projectDir}" diff --stat ${baseSha}..HEAD`, { encoding: "utf-8" });
    const full = execSync(`git -C "${projectDir}" diff ${baseSha}..HEAD`, { encoding: "utf-8" });
    if (full.length <= maxChars) {
      return `${stat}\n---\n${full}`;
    }
    return `${stat}\n---\n${full.slice(0, maxChars)}\n\n... [diff truncated, ${full.length} total chars]`;
  } catch (e) {
    return `(diff failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

// Tiny shell-escape helper. Sufficient for our paths; not a general escape utility.
function shellEscape(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}
