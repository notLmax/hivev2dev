/**
 * index.ts
 * Neato Hive — entry point.
 * 
 * Usage: node dist/index.js --agent <agent-name>
 * 
 * Each agent runs as its own process with its own Discord bot.
 * PM2 manages each agent independently:
 *   pm2 start dist/index.js --name house-md -- --agent house-md
 *   pm2 start dist/index.js --name house-md -- --agent house-md
 */

import "dotenv/config";
import { startBot } from "./discord/bot.js";
import { initCronJobs } from "./tools/cron.js";
import { registerDiscordClient } from "./tools/messaging.js";
import { loadModelCatalog, validateCatalog } from "./core/model-catalog.js";
import { join } from "path";

function getAgentName(): string {
  const idx = process.argv.indexOf("--agent");
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error("Usage: node dist/index.js --agent <agent-name>");
    console.error("Example: node dist/index.js --agent house-md");
    process.exit(1);
  }
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const agentName = getAgentName();
  // Identify this process to the cron layer (and anything else that scopes by
  // agent). MUST be set before initCronJobs so a process only fires its own
  // jobs — otherwise every agent fires every job.
  process.env.HIVE_AGENT_NAME = agentName;
  const tokenEnvVar = `DISCORD_BOT_TOKEN_${agentName.toUpperCase().replace(/-/g, "_")}`;
  const token = process.env[tokenEnvVar];

  if (!token) {
    console.error(`Missing ${tokenEnvVar} in .env`);
    console.error(`Add: ${tokenEnvVar}=<your bot token>`);
    process.exit(1);
  }

  const ownerId = process.env.DISCORD_OWNER_ID;
  if (!ownerId) {
    console.error("Missing DISCORD_OWNER_ID in .env");
    process.exit(1);
  }

  console.log("================================================");
  console.log(`  Neato Hive — ${agentName}`);
  console.log("================================================");
  console.log();

  const configPath = join(process.cwd(), "config", "config.yaml");
  console.log(`[config] Loading from ${configPath}`);
  console.log(`[auth] Claude: using CLI-managed auth`);

  // Model catalog audit (config/models.yaml, 04 §3) — doctor-style: problems
  // with OTHER agents' assignments are warnings here; THIS agent's broken
  // assignment throws inside resolveAgentConfig (startBot) and is fatal.
  try {
    const catalog = loadModelCatalog();
    if (catalog) {
      const { errors, warnings } = validateCatalog(catalog);
      for (const w of warnings) console.warn(`[models.yaml] warning: ${w}`);
      for (const e of errors) console.error(`[models.yaml] ERROR: ${e}`);
      const assigned = catalog.agents[agentName]?.model;
      console.log(
        `[models.yaml] catalog loaded: ${Object.keys(catalog.entries).length} models, ` +
          `${Object.keys(catalog.agents).length} assignments` +
          (assigned ? ` — ${agentName} → ${assigned}` : ` — ${agentName}: passthrough`)
      );
    }
  } catch (err) {
    console.error(`[models.yaml] failed to load:`, err);
    process.exit(1);
  }

  const client = await startBot({
    token,
    ownerId,
    configPath,
    agentName,
  });

  // Register Discord client for cross-channel messaging tool
  registerDiscordClient(client);

  // Initialize persisted cron jobs
  initCronJobs();

  console.log();
  console.log(`[ready] ${agentName} is online.`);

  const shutdown = async () => {
    console.log("\n[shutdown] Shutting down...");
    client.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
