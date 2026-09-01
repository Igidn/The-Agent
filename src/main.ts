import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/index.js';
import { Charter } from './core/charter.js';
import { SessionManager } from './core/session.js';
import { MessageQueue } from './core/queue.js';
import { Gateway } from './api/gateway.js';
import { WindowManager } from './core/window/window-manager.js';
import { MemoryCompactionSink } from './memory/sink.js';
import { SqliteMemoryStore } from './memory/store.js';
import { createEmbeddingProvider } from './memory/embeddings.js';
import { createMemorySearchTool } from './memory/tool.js';
import { MemoryService } from './memory/service.js';
import { TurnExtractor } from './memory/turn-extractor.js';
import { extractFacts, ingestFact } from './memory/extract.js';
import { consolidateProfile, renderProfileSection } from './memory/consolidation.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

/**
 * Daemon entry point.
 *
 * Start order:
 *   config → charter → memory service → window manager → session
 *   → turn extractor → message queue → gateway → signal handlers
 *
 * Shutdown order:
 *   gateway stop → queue dispose → window manager dispose
 *   → memory dispose → session stop
 */
export async function main(): Promise<void> {
  // 1. Config
  const config = loadConfig();

  // 2. Startup banner
  {
    const model = config.model
      ? `${config.model.provider}/${config.model.id}`
      : 'auto (first available)';
    const lines = [
      '',
      '  ┌────────────────────────────────────────────┐',
      `  │  The Agent daemon                           │`,
      `  │  gateway  http://${config.host}:${config.port}           │`,
      `  │  model    ${model.padEnd(36)}│`,
      `  │  persona  ${config.personaDir.padEnd(36)}│`,
      '  └────────────────────────────────────────────┘',
      '',
    ];
    console.log(lines.join('\n'));
  }

  // 3. Charter (persona)
  const charter = new Charter(config.personaDir);
  await charter.load();
  if (!charter.systemPrompt) {
    console.warn('Daemon: no system prompt loaded; session will use pi defaults');
  }
  charter.watch(() => {
    console.log('Daemon: persona hot-reloaded');
  });

  // 4. Memory service (store, embeddings, facade)
  const memoryConfig = config.memory;
  if (!memoryConfig) {
    throw new Error('Memory config is required. Set MEMORY_DB_PATH and related env vars.');
  }
  const models = builtinModels();
  const embeddings = createEmbeddingProvider(memoryConfig);
  const store = new SqliteMemoryStore(memoryConfig.dbPath, embeddings);
  const memoryService = new MemoryService(memoryConfig, store, embeddings);

  // 5. Resolve cheap model for background passes (extraction, consolidation)
  const cheapModelSpec = config.cheapModel ?? config.model;
  if (!cheapModelSpec) {
    throw new Error(
      'No model configured. Set MODEL_PROVIDER and MODEL_ID, ' +
        'or CHEAP_MODEL_PROVIDER and CHEAP_MODEL_ID.',
    );
  }
  const cheapModel = models.getModel(cheapModelSpec.provider, cheapModelSpec.id);
  if (!cheapModel) {
    throw new Error(
      `Cheap model ${cheapModelSpec.provider}/${cheapModelSpec.id} not found. ` +
        'Check that the provider is configured and the model id is correct.',
    );
  }

  // 6. Bound functions for the compaction sink
  const boundExtractFacts = (
    msgs: Parameters<typeof extractFacts>[0],
    signal?: AbortSignal,
  ) => extractFacts(msgs, cheapModel, models, signal);

  const boundIngestFact = (fact: Parameters<typeof ingestFact>[1], sourceEntryId: string | null) =>
    ingestFact(store, fact, sourceEntryId);

  // 7. Window manager with MemoryCompactionSink (replaces JsonlCompactionSink).
  //    Built before the session: its extension must ride the session's
  //    resource loader at creation time.
  const memorySink = new MemoryCompactionSink(
    store,
    boundExtractFacts,
    boundIngestFact,
    async () => {},
    embeddings,
  );

  const windowManager = new WindowManager(config.compaction, memorySink, {
    cheapModel: config.cheapModel,
  });

  // 8. Wire boundary callback for profile consolidation and charter update.
  //    This is the one sanctioned system-prompt mutation point: the cache
  //    is already dead from the summary rewrite.
  windowManager.onBoundary(async () => {
    try {
      const items = await consolidateProfile(store, cheapModel, models);
      const section = renderProfileSection(items);
      if (section) {
        charter.setProfileSection(section);
      }
    } catch (err) {
      console.warn('Daemon: profile consolidation failed', err);
    }
  });

  // 9. Create the memory_search tool and pass it to the session
  const memorySearchTool = createMemorySearchTool(store, memoryConfig);

  // 10. Session manager
  const sessionManager = new SessionManager(charter, windowManager);
  await sessionManager.start(config, [memorySearchTool]);

  // 11. Turn extractor (per-turn fact extraction, fire-and-forget)
  const turnExtractor = new TurnExtractor(store, extractFacts, cheapModel, models);
  memoryService.setTurnExtractor(turnExtractor);
  memoryService.bindSession(sessionManager.session);

  // 12. Message queue with memory prefetch
  const messageQueue = new MessageQueue(sessionManager, memoryService, windowManager);
  messageQueue.start();

  // 13. Gateway (HTTP + WebSocket) with memory routes
  const gateway = new Gateway(sessionManager, messageQueue, windowManager, memoryService);
  await gateway.start({ host: config.host, port: config.port });

  // 14. Signal handlers
  const shutdown = async (signal: string) => {
    console.log(`\nDaemon: ${signal} received, shutting down...`);
    await gateway.stop();
    windowManager.dispose();
    messageQueue.dispose();
    await memoryService.dispose();
    await sessionManager.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('Daemon: ready');
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  main().catch((err) => {
    console.error('Daemon: fatal error', err);
    process.exit(1);
  });
}