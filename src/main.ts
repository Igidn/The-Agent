import { fileURLToPath } from "node:url";
import { loadConfig, type DaemonConfig } from "./config/index.js";
import { Charter } from "./core/charter.js";
import { SessionManager } from "./core/session.js";
import { MessageQueue } from "./core/queue.js";
import { Gateway } from "./api/gateway.js";

/**
 * Daemon entry point.
 *
 * Start order: config → logging → charter → session → queue → gateway → signal handlers
 * Shutdown order: gateway stop → queue dispose → session stop
 */
export async function main(): Promise<void> {
  // 1. Config
  const config = loadConfig();

  // 2. Startup banner
  printBanner(config);

  // 3. Charter (persona)
  const charter = new Charter(config.personaDir);
  await charter.load();
  if (!charter.systemPrompt) {
    console.warn("Daemon: no system prompt loaded; session will use pi defaults");
  }
  charter.watch(() => {
    console.log("Daemon: persona hot-reloaded");
  });

  // 4. Session manager
  const sessionManager = new SessionManager(charter);
  await sessionManager.start(config);

  // 5. Message queue
  const messageQueue = new MessageQueue(sessionManager);
  messageQueue.start();

  // 6. Gateway (HTTP + WebSocket)
  const gateway = new Gateway(sessionManager, messageQueue);
  await gateway.start({ host: config.host, port: config.port });

  // 7. Signal handlers
  const shutdown = async (signal: string) => {
    console.log(`\nDaemon: ${signal} received, shutting down...`);
    await gateway.stop();
    messageQueue.dispose();
    await sessionManager.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep alive
  console.log("Daemon: ready");
}

function printBanner(config: DaemonConfig): void {
  const model = config.model
    ? `${config.model.provider}/${config.model.id}`
    : "auto (first available)";

  const lines = [
    "",
    "  ┌────────────────────────────────────────────┐",
    `  │  The Agent daemon                           │`,
    `  │  gateway  http://${config.host}:${config.port}           │`,
    `  │  model    ${model.padEnd(36)}│`,
    `  │  persona  ${config.personaDir.padEnd(36)}│`,
    "  └────────────────────────────────────────────┘",
    "",
  ];
  console.log(lines.join("\n"));
}

const isEntryPoint = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  main().catch((err) => {
    console.error("Daemon: fatal error", err);
    process.exit(1);
  });
}