/**
 * hive-tools-server.ts
 * In-process MCP server exposing custom Hive tools to the agent.
 * Uses the Claude Agent SDK's createSdkMcpServer for zero-overhead tool registration.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

import { cronAdd, cronListForAgent, cronRemove } from "./cron.js";
import { memorySearch, memoryGet, memoryAppend } from "./memory.js";
import { applyPatch } from "./patch.js";
import { processStart, processList, processLogs, processKill, processSendKeys } from "./process.js";
import { sendToAgent, sendToChannel, sendToChannelById, hivemindProcessingActive } from "./messaging.js";
import { launchTask, listTasks } from "./codex-tasks.js";

/**
 * Creates the Hive custom tools MCP server.
 * Pass the agent's behavior directory so memory tools know where to look.
 */
export function createHiveToolsServer(behaviorDir: string, agentName?: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "hive-tools",
    version: "1.0.0",
    tools: [

      // ── Cron ──────────────────────────────────────────────
      tool(
        "CronCreate",
        "Create a scheduled job on a cron schedule. Jobs persist across restarts. " +
        "Two types: 'agent' (default) sends a prompt through your AI session and posts results to Discord. " +
        "'shell' runs a raw shell command. " +
        "Use standard cron expressions (e.g. '*/5 * * * *' for every 5 minutes, '0 9 * * 1' for Mondays at 9am).",
        {
          schedule: z.string().describe("Cron expression (e.g. '0 * * * *' for hourly)"),
          command: z.string().describe("Agent prompt (type=agent) or shell command (type=shell)"),
          description: z.string().describe("Human-readable description of what this job does"),
          type: z.enum(["agent", "shell"]).optional().describe("Job type: 'agent' (default) runs an AI prompt, 'shell' runs a command"),
        },
        async (args) => {
          try {
            const owner = process.env.HIVE_AGENT_NAME || agentName || "";
            const job = cronAdd(owner, args.schedule, args.command, args.description, args.type ?? "agent");
            return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
          }
        }
      ),

      tool(
        "CronList",
        "List YOUR scheduled cron jobs with their IDs, schedules, commands, and status.",
        {},
        async () => {
          const owner = process.env.HIVE_AGENT_NAME || agentName || "";
          const jobs = cronListForAgent(owner);
          if (jobs.length === 0) {
            return { content: [{ type: "text", text: "No cron jobs configured." }] };
          }
          return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] };
        }
      ),

      tool(
        "CronDelete",
        "Delete one of YOUR scheduled cron jobs by its ID. Use CronList to find job IDs.",
        {
          id: z.string().describe("The cron job ID (e.g. 'cron-1712345678')"),
        },
        async (args) => {
          // Scope to this agent: refuse to delete another agent's job.
          const owner = process.env.HIVE_AGENT_NAME || agentName || "";
          const mine = cronListForAgent(owner).some((j) => j.id === args.id);
          if (!mine) {
            return { content: [{ type: "text", text: `Cron job ${args.id} not found` }], isError: true };
          }
          const removed = cronRemove(args.id);
          if (removed) {
            return { content: [{ type: "text", text: `Deleted cron job ${args.id}` }] };
          }
          return { content: [{ type: "text", text: `Cron job ${args.id} not found` }], isError: true };
        }
      ),

      // ── Memory ────────────────────────────────────────────
      tool(
        "MemorySearch",
        "Search your MEMORY.md file using keywords. Returns the most relevant entries " +
        "ranked by how many search terms match. Use this to recall facts, preferences, " +
        "or context from previous sessions.",
        {
          query: z.string().describe("Search keywords (e.g. 'font preferences' or 'AC project stack')"),
          topK: z.number().optional().describe("Max results to return (default: 5)"),
        },
        async (args) => {
          const results = memorySearch(behaviorDir, args.query, args.topK ?? 5);
          if (results.length === 0) {
            return { content: [{ type: "text", text: "No matching entries found in MEMORY.md" }] };
          }
          const formatted = results.map(r => `[${r.section}] ${r.content}`).join("\n");
          return { content: [{ type: "text", text: formatted }] };
        }
      ),

      tool(
        "MemoryGet",
        "Get all entries from a specific section of your MEMORY.md file.",
        {
          section: z.string().describe("Section name (e.g. 'Preferences', 'Infrastructure', 'Projects')"),
        },
        async (args) => {
          const entries = memoryGet(behaviorDir, args.section);
          if (entries.length === 0) {
            return { content: [{ type: "text", text: `No entries found in section "${args.section}"` }] };
          }
          const formatted = entries.map(e => `- ${e.content}`).join("\n");
          return { content: [{ type: "text", text: `## ${args.section}\n${formatted}` }] };
        }
      ),

      tool(
        "MemoryAppend",
        "Add a new entry to a section in your MEMORY.md file. Creates the section if it doesn't exist. " +
        "Use this to persist important facts, preferences, or decisions across sessions.",
        {
          section: z.string().describe("Section name to append to (e.g. 'Preferences', 'Infrastructure')"),
          content: z.string().describe("The entry to add (will be formatted as a list item)"),
        },
        async (args) => {
          try {
            memoryAppend(behaviorDir, args.section, args.content);
            return { content: [{ type: "text", text: `Added to ${args.section}: ${args.content}` }] };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
          }
        }
      ),

      // ── Patch ─────────────────────────────────────────────
      tool(
        "FilePatch",
        "Apply multiple search-and-replace edits to a file in one atomic operation. " +
        "ALL hunks must match or the entire patch is rejected — no partial edits. " +
        "Use this when you need to make several related changes to a file at once.",
        {
          filepath: z.string().describe("Absolute path to the file to patch"),
          hunks: z.array(z.object({
            search: z.string().describe("Exact text to find in the file"),
            replace: z.string().describe("Text to replace it with"),
          })).describe("Array of search/replace pairs to apply"),
        },
        async (args) => {
          const result = applyPatch(args.filepath, args.hunks);
          if (result.success) {
            return { content: [{ type: "text", text: `Patched ${result.filepath}: ${result.hunksApplied}/${result.hunksTotal} hunks applied` }] };
          }
          const errText = `Patch failed on ${result.filepath}:\n${result.errors.join("\n")}`;
          return { content: [{ type: "text", text: errText }], isError: true };
        }
      ),

      // ── Process ───────────────────────────────────────────
      tool(
        "ProcessStart",
        "Start a background process and capture its output. Returns a process ID " +
        "you can use to check logs, send input, or kill it. Processes are tracked " +
        "in memory only (lost on agent restart).",
        {
          command: z.string().describe("Command to run (e.g. 'npm run dev')"),
        },
        async (args) => {
          const proc = processStart(args.command);
          return { content: [{ type: "text", text: JSON.stringify({
            id: proc.id,
            pid: proc.pid,
            command: proc.command,
            status: proc.status,
          }, null, 2) }] };
        }
      ),

      tool(
        "ProcessList",
        "List all managed background processes with their status.",
        {},
        async () => {
          const list = processList();
          if (list.length === 0) {
            return { content: [{ type: "text", text: "No managed processes." }] };
          }
          const summary = list.map(p =>
            `${p.id} | ${p.status} | pid:${p.pid} | ${p.command}`
          ).join("\n");
          return { content: [{ type: "text", text: summary }] };
        }
      ),

      tool(
        "ProcessLogs",
        "Get recent output (stdout + stderr) from a managed background process.",
        {
          id: z.string().describe("Process ID (e.g. 'proc-1712345678')"),
          lines: z.number().optional().describe("Number of recent lines to return (default: 50)"),
        },
        async (args) => {
          const logs = processLogs(args.id, args.lines ?? 50);
          return { content: [{ type: "text", text: logs.join("\n") || "(no output)" }] };
        }
      ),

      tool(
        "ProcessKill",
        "Kill a managed background process by its ID.",
        {
          id: z.string().describe("Process ID to kill"),
        },
        async (args) => {
          const killed = processKill(args.id);
          if (killed) {
            return { content: [{ type: "text", text: `Killed process ${args.id}` }] };
          }
          return { content: [{ type: "text", text: `Process ${args.id} not found` }], isError: true };
        }
      ),

      tool(
        "ProcessSendKeys",
        "Send input (keystrokes) to a managed background process's stdin.",
        {
          id: z.string().describe("Process ID"),
          input: z.string().describe("Text to send to stdin (include \\n for Enter)"),
        },
        async (args) => {
          const sent = processSendKeys(args.id, args.input);
          if (sent) {
            return { content: [{ type: "text", text: `Sent input to ${args.id}` }] };
          }
          return { content: [{ type: "text", text: `Failed to send to ${args.id} (not found or no stdin)` }], isError: true };
        }
      ),

      // ── Messaging ─────────────────────────────────────────
      tool(
        "SendMessage",
        "Send a message to another agent via #hivemind. The message appears in the " +
        "hivemind channel where the target agent picks it up. Use this to delegate tasks, " +
        "ask questions, or share information with other agents. The conversation happens " +
        "in the background — you can continue your current conversation immediately.",
        {
          to: z.string().describe("Target agent name (e.g. 'your-analyst', 'your-coder')"),
          message: z.string().describe("Message to send to the other agent"),
        },
        async (args) => {
          // Block SendMessage during hivemind processing — bot handles response routing
          if (hivemindProcessingActive) {
            return { content: [{ type: "text", text: "SendMessage blocked: you're responding to a hivemind message. Your text response will be automatically routed back. No need to call SendMessage." }] };
          }
          const from = agentName || "unknown";
          const result = await sendToAgent(from, args.to, args.message);
          if (result.success) {
            return { content: [{ type: "text", text: `Message sent to ${args.to} via #hivemind. They'll pick it up and respond there.` }] };
          }
          return { content: [{ type: "text", text: `Failed: ${result.error}` }], isError: true };
        }
      ),

      // ── Codex Tasks (long-running fire-and-forget) ────────
      tool(
        "LaunchCodexTask",
        "Launch a long-running Codex task in tmux as fire-and-forget. " +
        "When Codex finishes, you'll be woken with the output and a Codex Completion " +
        "Protocol prompt — review the diff, QA the deploy, deploy / refix / wait per your " +
        "AGENTS.md. Use this INSTEAD of raw `tmux send-keys` for any Codex work. " +
        "Returns immediately so you can end your turn. " +
        "WAVE DISCIPLINE: if `wave_context` is set, you will NOT auto-advance to the next " +
        "wave on completion — the owner must sign off first.",
        {
          task_name: z.string().describe(
            "Short slug for this task (e.g. 'flow-catalog-fix-1'). Used as tmux session name."
          ),
          prompt_file: z.string().describe(
            "Path to the spec markdown file, relative to project_dir (e.g. 'docs/TASK.md'). " +
            "Codex will receive `cat <prompt_file>` as its input."
          ),
          project_dir: z.string().describe(
            "Absolute path to the project directory (e.g. '/home/user/code/my-project')."
          ),
          wave_context: z.string().optional().describe(
            "If part of a multi-wave plan, describe it (e.g. 'Wave 3 of 5: catalog hygiene'). " +
            "On completion, you must STOP and wait for owner sign-off before launching the next wave."
          ),
          on_complete_prompt: z.string().optional().describe(
            "Optional override for the default Completion Protocol wake prompt. " +
            "Leave unset for default (review → QA → action)."
          ),
        },
        async (args) => {
          try {
            const agent = agentName || "unknown";
            const task = launchTask({
              agent,
              channel: "auto",  // resolved by watcher from agent's own config
              taskName: args.task_name,
              projectDir: args.project_dir,
              promptFile: args.prompt_file,
              waveContext: args.wave_context,
              onCompletePrompt: args.on_complete_prompt,
            });
            return {
              content: [{
                type: "text",
                text: `Codex task launched.\n\n` +
                      `taskId: ${task.taskId}\n` +
                      `tmux session: ${task.sessionName}\n` +
                      `project: ${task.projectDir}\n` +
                      `prompt: ${task.promptFile}\n` +
                      (task.waveContext ? `wave: ${task.waveContext}\n` : "") +
                      (task.baseSha ? `baseSha: ${task.baseSha.slice(0, 8)}\n` : "") +
                      `\nEnd your turn. You will be woken when Codex completes. ` +
                      `Status checks: \`tmux capture-pane -t ${task.sessionName} -p | tail -30\` ` +
                      `or call ListCodexTasks.`
              }]
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: [{ type: "text", text: `LaunchCodexTask failed: ${msg}` }], isError: true };
          }
        }
      ),

      tool(
        "ListCodexTasks",
        "List Codex tasks owned by this agent. Filter by status: 'running', 'completed', 'failed', 'timeout'. " +
        "Use this to check what's still in flight without polling tmux directly.",
        {
          status: z.enum(["running", "completed", "failed", "timeout"]).optional().describe(
            "Filter by status. Omit to list all."
          ),
        },
        async (args) => {
          const tasks = listTasks({
            agent: agentName,
            status: args.status,
          });
          if (tasks.length === 0) {
            return { content: [{ type: "text", text: `No tasks${args.status ? ` with status=${args.status}` : ""}.` }] };
          }
          const summary = tasks.map((t) =>
            `- ${t.taskId} [${t.status}] ${t.taskName} (started ${t.startedAt})` +
            (t.waveContext ? ` — ${t.waveContext}` : "")
          ).join("\n");
          return { content: [{ type: "text", text: summary }] };
        }
      ),
    ],
  });
}
