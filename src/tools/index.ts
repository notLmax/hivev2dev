/**
 * tools/index.ts
 * Central registry for all custom tools.
 * The Agent SDK handles built-in tools (bash, files, web).
 * This module exports our custom additions.
 */

export { memorySearch, memoryGet, memoryAppend } from "./memory.js";
export { cronAdd, cronList, cronListForAgent, cronRemove, initCronJobs } from "./cron.js";
export {
  processStart,
  processList,
  processLogs,
  processKill,
  processSendKeys,
} from "./process.js";
export { sendToAgent, sendToChannel, sendToChannelById, registerDiscordClient } from "./messaging.js";
export { applyPatch } from "./patch.js";
