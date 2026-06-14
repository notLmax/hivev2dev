/**
 * cron.ts
 * Manage scheduled jobs using node-cron.
 * Jobs persist to disk so they survive restarts.
 *
 * Two job types:
 *   - "shell": runs a command via execSync (legacy)
 *   - "agent": sends a prompt through the agent's AI session and posts results to Discord
 *
 * PER-AGENT OWNERSHIP (restored from v1): every job carries an `agent` field.
 * One process per agent shares ./data/cron-jobs.json, so each process MUST only
 * fire jobs whose `agent` matches its own HIVE_AGENT_NAME — otherwise every
 * agent fires every job (duplicate execution + cross-agent identity bleed) and
 * any agent's delete removes another's. startJob/initCronJobs gate on it.
 */

import cron from "node-cron";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, watch } from "fs";
import { join, dirname } from "path";

export interface CronJob {
  id: string;
  agent: string;       // which agent owns this cron — required, non-empty
  schedule: string;
  description: string;
  command: string; // Shell command (type=shell) or agent prompt (type=agent)
  type: "shell" | "agent";
  createdAt: string;
  enabled: boolean;
}

type AgentExecutor = (prompt: string) => Promise<string>;

// Paths are env-overridable so tests can isolate to a temp file; production
// uses the defaults under ./data (relative to each agent process's cwd).
function cronFile(): string {
  return process.env.HIVE_CRON_FILE || "./data/cron-jobs.json";
}
function cronLogDir(): string {
  return process.env.HIVE_CRON_LOG_DIR || "./data/cron-logs";
}

export const activeTasks = new Map<string, cron.ScheduledTask>();
let agentExecutor: AgentExecutor | undefined;

function ensureDirs(): void {
  const dir = dirname(cronFile());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(cronLogDir())) mkdirSync(cronLogDir(), { recursive: true });
}

export function loadJobs(): CronJob[] {
  ensureDirs();
  if (!existsSync(cronFile())) return [];
  const jobs = JSON.parse(readFileSync(cronFile(), "utf-8")) as CronJob[];
  for (const job of jobs) {
    if (!job.type) job.type = "shell";
  }
  return jobs;
}

function saveJobs(jobs: CronJob[]): void {
  ensureDirs();
  writeFileSync(cronFile(), JSON.stringify(jobs, null, 2));
}

/**
 * Registers the agent executor callback.
 * Called by bot.ts after the Discord client is ready.
 */
export function setAgentExecutor(executor: AgentExecutor): void {
  agentExecutor = executor;
  console.log("[cron] Agent executor registered — agent-type jobs will trigger AI work");
}

/**
 * Adds a new cron job. Requires a non-empty agent name (the owner).
 */
export function cronAdd(
  agent: string,
  schedule: string,
  command: string,
  description: string,
  type: "shell" | "agent" = "agent"
): CronJob {
  if (!agent || typeof agent !== "string" || agent.trim() === "") {
    throw new Error("cronAdd requires a non-empty agent name");
  }
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }

  const job: CronJob = {
    id: `cron-${Date.now()}`,
    agent,
    schedule,
    description,
    command,
    type,
    createdAt: new Date().toISOString(),
    enabled: true,
  };

  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);

  startJob(job);

  return job;
}

/** Lists ALL cron jobs (every agent). Prefer cronListForAgent for tools. */
export function cronList(): CronJob[] {
  return loadJobs();
}

/** Lists cron jobs owned by a specific agent. */
export function cronListForAgent(agent: string): CronJob[] {
  return loadJobs().filter((j) => j.agent === agent);
}

/**
 * Removes a cron job by ID. Always tries to stop the active in-memory task,
 * even if the registry entry was already removed by another process.
 * Tool callers scope deletion to the calling agent (see hive-tools).
 */
export function cronRemove(id: string): boolean {
  const jobs = loadJobs();
  const filtered = jobs.filter((j) => j.id !== id);
  const wasInRegistry = filtered.length !== jobs.length;

  if (wasInRegistry) saveJobs(filtered);

  const task = activeTasks.get(id);
  let wasActive = false;
  if (task) {
    task.stop();
    activeTasks.delete(id);
    wasActive = true;
  }

  return wasInRegistry || wasActive;
}

/**
 * Starts a cron job's scheduled task — ONLY if this process owns it.
 */
function startJob(job: CronJob): void {
  if (!job.enabled) return;

  const thisAgent = process.env.HIVE_AGENT_NAME;
  if (!thisAgent) return;            // safety net (init refuses first)
  if (job.agent !== thisAgent) return; // not mine — don't fire another agent's job
  if (activeTasks.has(job.id)) return; // idempotent

  const task = cron.schedule(job.schedule, async () => {
    const timestamp = new Date().toISOString();
    const logFile = join(cronLogDir(), `${job.id}.log`);

    console.log(`[cron] ${thisAgent} firing job ${job.id} (${job.type}): ${job.description}`);

    try {
      let output: string;

      if (job.type === "agent") {
        if (!agentExecutor) {
          throw new Error("Agent executor not registered — cannot run agent-type cron jobs");
        }
        output = await agentExecutor(job.command);
      } else {
        const { execSync } = await import("child_process");
        output = execSync(job.command, { timeout: 60_000, encoding: "utf-8" });
      }

      appendFileSync(logFile, `[${timestamp}] OK: ${(output || "").trim()}\n`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      appendFileSync(logFile, `[${timestamp}] ERROR: ${errMsg}\n`);
      console.error(`[cron] Job ${job.id} failed: ${errMsg}`);
    }
  });

  activeTasks.set(job.id, task);
}

// ── File watcher with debounce — cross-process reconciliation ──

let reconcileTimer: NodeJS.Timeout | null = null;
let watcher: ReturnType<typeof watch> | null = null;

function debouncedReconcile(): void {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    try {
      reconcileActiveTasks();
    } catch (e) {
      console.error("[cron] reconcile failed; will retry on next event:", e);
    }
  }, 250);
}

function setupWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (existsSync(cronFile())) {
    watcher = watch(cronFile(), { persistent: false }, debouncedReconcile);
  }
}

export function reconcileActiveTasks(): void {
  const thisAgent = process.env.HIVE_AGENT_NAME;
  if (!thisAgent) return;

  let jobs: CronJob[];
  try {
    jobs = loadJobs();
  } catch (e) {
    console.warn("[cron] reconcile read failed; skipping this cycle:", e);
    return;
  }

  const currentJobs = jobs.filter((j) => j.agent === thisAgent && j.enabled);
  const currentIds = new Set(currentJobs.map((j) => j.id));

  for (const [id, task] of activeTasks.entries()) {
    if (!currentIds.has(id)) {
      task.stop();
      activeTasks.delete(id);
      console.log(`[cron] reconcile: stopped stale task ${id}`);
    }
  }
  for (const job of currentJobs) {
    if (!activeTasks.has(job.id)) {
      startJob(job);
      console.log(`[cron] reconcile: started new task ${job.id}`);
    }
  }
}

/**
 * Initializes saved cron jobs on startup — ONLY this agent's jobs.
 * Refuses to start anything if HIVE_AGENT_NAME is unset (prevents the
 * every-agent-fires-every-job fan-out).
 */
export function initCronJobs(): void {
  const thisAgent = process.env.HIVE_AGENT_NAME;
  if (!thisAgent) {
    console.warn("[cron] HIVE_AGENT_NAME not set — refusing to start any cron jobs in this process.");
    return;
  }

  const jobs = loadJobs();
  const ownJobs = jobs.filter((j) => j.agent === thisAgent && j.enabled);

  const legacy = jobs.filter((j) => !j.agent || j.agent.trim() === "");
  if (legacy.length > 0) {
    console.warn(`[cron] ${legacy.length} legacy job(s) without an 'agent' field — they will NOT fire. Re-create via CronCreate.`);
    for (const j of legacy) console.warn(`  - id=${j.id} schedule=${j.schedule} desc=${j.description}`);
  }

  for (const job of ownJobs) startJob(job);
  console.log(`[cron] ${thisAgent}: scheduled ${ownJobs.length} of ${jobs.length} total job(s) in registry.`);

  setupWatcher();
}

// ── Test helper ──────────────────────────────────────────────

export function _resetCronForTesting(): void {
  for (const [id, task] of activeTasks.entries()) {
    task.stop();
    activeTasks.delete(id);
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }
}
