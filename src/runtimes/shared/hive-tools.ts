/**
 * hive-tools.ts — the 15 Hive custom tools for loop-owning runtimes.
 *
 * SCHEMA-IDENTITY RULE: names, descriptions, parameters, and result strings
 * mirror src/tools/hive-tools-server.ts (the SDK lane's MCP server) exactly —
 * guarded by tests/shared-tools.test.ts. Both layers wrap the same underlying
 * functions in src/tools/*.
 */

import { cronAdd, cronListForAgent, cronRemove } from "../../tools/cron.js";
import { memorySearch, memoryGet, memoryAppend } from "../../tools/memory.js";
import { applyPatch } from "../../tools/patch.js";
import {
  processStart,
  processList,
  processLogs,
  processKill,
  processSendKeys,
} from "../../tools/process.js";
import { sendToAgent, hivemindProcessingActive } from "../../tools/messaging.js";
import { launchTask, listTasks } from "../../tools/codex-tasks.js";
import type { SharedTool } from "./tool-registry.js";

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

export function createHiveTools(): SharedTool[] {
  return [
    // ── Cron ──────────────────────────────────────────────
    {
      name: "CronCreate",
      description:
        "Create a scheduled job on a cron schedule. Jobs persist across restarts. " +
        "Two types: 'agent' (default) sends a prompt through your AI session and posts results to Discord. " +
        "'shell' runs a raw shell command. " +
        "Use standard cron expressions (e.g. '*/5 * * * *' for every 5 minutes, '0 9 * * 1' for Mondays at 9am).",
      inputSchema: {
        type: "object",
        properties: {
          schedule: str("Cron expression (e.g. '0 * * * *' for hourly)"),
          command: str("Agent prompt (type=agent) or shell command (type=shell)"),
          description: str("Human-readable description of what this job does"),
          type: { type: "string", enum: ["agent", "shell"], description: "Job type: 'agent' (default) runs an AI prompt, 'shell' runs a command" },
        },
        required: ["schedule", "command", "description"],
      },
      async execute(args) {
        try {
          const owner = process.env.HIVE_AGENT_NAME || "";
          const job = cronAdd(owner, args.schedule, args.command, args.description, args.type ?? "agent");
          return { text: JSON.stringify(job, null, 2) };
        } catch (e) {
          return { text: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      },
    },
    {
      name: "CronList",
      description: "List YOUR scheduled cron jobs with their IDs, schedules, commands, and status.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const jobs = cronListForAgent(process.env.HIVE_AGENT_NAME || "");
        if (jobs.length === 0) return { text: "No cron jobs configured." };
        return { text: JSON.stringify(jobs, null, 2) };
      },
    },
    {
      name: "CronDelete",
      description: "Delete one of YOUR scheduled cron jobs by its ID. Use CronList to find job IDs.",
      inputSchema: {
        type: "object",
        properties: { id: str("The cron job ID (e.g. 'cron-1712345678')") },
        required: ["id"],
      },
      async execute(args) {
        // Scope to this agent: refuse to delete another agent's job.
        const owner = process.env.HIVE_AGENT_NAME || "";
        const mine = cronListForAgent(owner).some((j) => j.id === args.id);
        if (!mine) return { text: `Cron job ${args.id} not found`, isError: true };
        const removed = cronRemove(args.id);
        if (removed) return { text: `Deleted cron job ${args.id}` };
        return { text: `Cron job ${args.id} not found`, isError: true };
      },
    },

    // ── Memory ────────────────────────────────────────────
    {
      name: "MemorySearch",
      description:
        "Search your MEMORY.md file using keywords. Returns the most relevant entries " +
        "ranked by how many search terms match. Use this to recall facts, preferences, " +
        "or context from previous sessions.",
      inputSchema: {
        type: "object",
        properties: {
          query: str("Search keywords (e.g. 'font preferences' or 'AC project stack')"),
          topK: num("Max results to return (default: 5)"),
        },
        required: ["query"],
      },
      async execute(args, ctx) {
        const results = memorySearch(ctx.behaviorDir, args.query, args.topK ?? 5);
        if (results.length === 0) return { text: "No matching entries found in MEMORY.md" };
        return { text: results.map((r) => `[${r.section}] ${r.content}`).join("\n") };
      },
    },
    {
      name: "MemoryGet",
      description: "Get all entries from a specific section of your MEMORY.md file.",
      inputSchema: {
        type: "object",
        properties: { section: str("Section name (e.g. 'Preferences', 'Infrastructure', 'Projects')") },
        required: ["section"],
      },
      async execute(args, ctx) {
        const entries = memoryGet(ctx.behaviorDir, args.section);
        if (entries.length === 0) return { text: `No entries found in section "${args.section}"` };
        return { text: `## ${args.section}\n${entries.map((e) => `- ${e.content}`).join("\n")}` };
      },
    },
    {
      name: "MemoryAppend",
      description:
        "Add a new entry to a section in your MEMORY.md file. Creates the section if it doesn't exist. " +
        "Use this to persist important facts, preferences, or decisions across sessions.",
      inputSchema: {
        type: "object",
        properties: {
          section: str("Section name to append to (e.g. 'Preferences', 'Infrastructure')"),
          content: str("The entry to add (will be formatted as a list item)"),
        },
        required: ["section", "content"],
      },
      async execute(args, ctx) {
        try {
          memoryAppend(ctx.behaviorDir, args.section, args.content);
          return { text: `Added to ${args.section}: ${args.content}` };
        } catch (e) {
          return { text: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      },
    },

    // ── Patch ─────────────────────────────────────────────
    {
      name: "FilePatch",
      description:
        "Apply multiple search-and-replace edits to a file in one atomic operation. " +
        "ALL hunks must match or the entire patch is rejected — no partial edits. " +
        "Use this when you need to make several related changes to a file at once.",
      inputSchema: {
        type: "object",
        properties: {
          filepath: str("Absolute path to the file to patch"),
          hunks: {
            type: "array",
            description: "Array of search/replace pairs to apply",
            items: {
              type: "object",
              properties: {
                search: str("Exact text to find in the file"),
                replace: str("Text to replace it with"),
              },
              required: ["search", "replace"],
            },
          },
        },
        required: ["filepath", "hunks"],
      },
      async execute(args) {
        const result = applyPatch(args.filepath, args.hunks);
        if (result.success) {
          return { text: `Patched ${result.filepath}: ${result.hunksApplied}/${result.hunksTotal} hunks applied` };
        }
        return { text: `Patch failed on ${result.filepath}:\n${result.errors.join("\n")}`, isError: true };
      },
    },

    // ── Process ───────────────────────────────────────────
    {
      name: "ProcessStart",
      description:
        "Start a background process and capture its output. Returns a process ID " +
        "you can use to check logs, send input, or kill it. Processes are tracked " +
        "in memory only (lost on agent restart).",
      inputSchema: {
        type: "object",
        properties: { command: str("Command to run (e.g. 'npm run dev')") },
        required: ["command"],
      },
      async execute(args) {
        const proc = processStart(args.command);
        return { text: JSON.stringify({ id: proc.id, pid: proc.pid, command: proc.command, status: proc.status }, null, 2) };
      },
    },
    {
      name: "ProcessList",
      description: "List all managed background processes with their status.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const list = processList();
        if (list.length === 0) return { text: "No managed processes." };
        return { text: list.map((p) => `${p.id} | ${p.status} | pid:${p.pid} | ${p.command}`).join("\n") };
      },
    },
    {
      name: "ProcessLogs",
      description: "Get recent output (stdout + stderr) from a managed background process.",
      inputSchema: {
        type: "object",
        properties: {
          id: str("Process ID (e.g. 'proc-1712345678')"),
          lines: num("Number of recent lines to return (default: 50)"),
        },
        required: ["id"],
      },
      async execute(args) {
        const logs = processLogs(args.id, args.lines ?? 50);
        return { text: logs.join("\n") || "(no output)" };
      },
    },
    {
      name: "ProcessKill",
      description: "Kill a managed background process by its ID.",
      inputSchema: {
        type: "object",
        properties: { id: str("Process ID to kill") },
        required: ["id"],
      },
      async execute(args) {
        const killed = processKill(args.id);
        if (killed) return { text: `Killed process ${args.id}` };
        return { text: `Process ${args.id} not found`, isError: true };
      },
    },
    {
      name: "ProcessSendKeys",
      description: "Send input (keystrokes) to a managed background process's stdin.",
      inputSchema: {
        type: "object",
        properties: {
          id: str("Process ID"),
          input: str("Text to send to stdin (include \\n for Enter)"),
        },
        required: ["id", "input"],
      },
      async execute(args) {
        const sent = processSendKeys(args.id, args.input);
        if (sent) return { text: `Sent input to ${args.id}` };
        return { text: `Failed to send to ${args.id} (not found or no stdin)`, isError: true };
      },
    },

    // ── Messaging ─────────────────────────────────────────
    {
      name: "SendMessage",
      description:
        "Send a message to another agent via #hivemind. The message appears in the " +
        "hivemind channel where the target agent picks it up. Use this to delegate tasks, " +
        "ask questions, or share information with other agents. The conversation happens " +
        "in the background — you can continue your current conversation immediately.",
      inputSchema: {
        type: "object",
        properties: {
          to: str("Target agent name (e.g. 'your-analyst', 'your-coder')"),
          message: str("Message to send to the other agent"),
        },
        required: ["to", "message"],
      },
      async execute(args, ctx) {
        if (hivemindProcessingActive) {
          return {
            text: "SendMessage blocked: you're responding to a hivemind message. Your text response will be automatically routed back. No need to call SendMessage.",
          };
        }
        const result = await sendToAgent(ctx.agentName || "unknown", args.to, args.message);
        if (result.success) return { text: `Message sent to ${args.to} via #hivemind. They'll pick it up and respond there.` };
        return { text: `Failed: ${result.error}`, isError: true };
      },
    },

    // ── Codex Tasks (long-running fire-and-forget) ────────
    {
      name: "LaunchCodexTask",
      description:
        "Launch a long-running Codex task in tmux as fire-and-forget. " +
        "When Codex finishes, you'll be woken with the output and a Codex Completion " +
        "Protocol prompt — review the diff, QA the deploy, deploy / refix / wait per your " +
        "AGENTS.md. Use this INSTEAD of raw `tmux send-keys` for any Codex work. " +
        "Returns immediately so you can end your turn. " +
        "WAVE DISCIPLINE: if `wave_context` is set, you will NOT auto-advance to the next " +
        "wave on completion — the owner must sign off first.",
      inputSchema: {
        type: "object",
        properties: {
          task_name: str("Short slug for this task (e.g. 'flow-catalog-fix-1'). Used as tmux session name."),
          prompt_file: str(
            "Path to the spec markdown file, relative to project_dir (e.g. 'docs/TASK.md'). " +
              "Codex will receive `cat <prompt_file>` as its input."
          ),
          project_dir: str("Absolute path to the project directory (e.g. '/home/user/code/my-project')."),
          wave_context: str(
            "If part of a multi-wave plan, describe it (e.g. 'Wave 3 of 5: catalog hygiene'). " +
              "On completion, you must STOP and wait for owner sign-off before launching the next wave."
          ),
          on_complete_prompt: str(
            "Optional override for the default Completion Protocol wake prompt. " +
              "Leave unset for default (review → QA → action)."
          ),
        },
        required: ["task_name", "prompt_file", "project_dir"],
      },
      async execute(args, ctx) {
        try {
          const task = launchTask({
            agent: ctx.agentName || "unknown",
            channel: "auto", // resolved by watcher from agent's own config
            taskName: args.task_name,
            projectDir: args.project_dir,
            promptFile: args.prompt_file,
            waveContext: args.wave_context,
            onCompletePrompt: args.on_complete_prompt,
          });
          return {
            text:
              `Codex task launched.\n\n` +
              `taskId: ${task.taskId}\n` +
              `tmux session: ${task.sessionName}\n` +
              `project: ${task.projectDir}\n` +
              `prompt: ${task.promptFile}\n` +
              (task.waveContext ? `wave: ${task.waveContext}\n` : "") +
              (task.baseSha ? `baseSha: ${task.baseSha.slice(0, 8)}\n` : "") +
              `\nEnd your turn. You will be woken when Codex completes. ` +
              `Status checks: \`tmux capture-pane -t ${task.sessionName} -p | tail -30\` ` +
              `or call ListCodexTasks.`,
          };
        } catch (e) {
          return { text: `LaunchCodexTask failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      },
    },
    {
      name: "ListCodexTasks",
      description:
        "List Codex tasks owned by this agent. Filter by status: 'running', 'completed', 'failed', 'timeout'. " +
        "Use this to check what's still in flight without polling tmux directly.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["running", "completed", "failed", "timeout"],
            description: "Filter by status. Omit to list all.",
          },
        },
      },
      async execute(args, ctx) {
        const tasks = listTasks({ agent: ctx.agentName, status: args.status });
        if (tasks.length === 0) return { text: `No tasks${args.status ? ` with status=${args.status}` : ""}.` };
        return {
          text: tasks
            .map(
              (t) =>
                `- ${t.taskId} [${t.status}] ${t.taskName} (started ${t.startedAt})` +
                (t.waveContext ? ` — ${t.waveContext}` : "")
            )
            .join("\n"),
        };
      },
    },
  ];
}
