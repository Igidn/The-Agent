import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { MemoryConfig } from '../shared/types.js';
import type { LiveWindow } from '../core/window/types.js';
import type {
  EmbeddingProvider,
  MemoryItem,
  MemoryStore,
  MemoryTier,
  MemoryTag,
  PrefetchResult,
  ScoredItem,
} from './types.js';
import { prefetch } from './prefetch.js';
import { TurnExtractor } from './turn-extractor.js';

/**
 * Facade over the memory subsystem.
 *
 * The module the rest of the daemon talks to.  Owns the store, embeddings,
 * and the turn extractor, and exposes convenience methods for prefetch,
 * search, CRUD, and session binding.
 *
 * If the ported pipeline disappoints, a FastAPI sidecar replaces the
 * internals without queue, session, or gateway noticing — the facade
 * contract stays the same.
 */
export class MemoryService {
  private readonly _store: MemoryStore;
  private readonly _embeddings: EmbeddingProvider;
  private readonly _config: MemoryConfig;
  private _turnExtractor: TurnExtractor | null = null;

  constructor(config: MemoryConfig, store: MemoryStore, embeddings: EmbeddingProvider) {
    this._config = config;
    this._store = store;
    this._embeddings = embeddings;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  /**
   * Set the turn extractor for per-turn fact extraction.
   *
   * Called during daemon startup after the service is created, so the
   * constructor stays at the three parameters the spec calls for.
   */
  setTurnExtractor(extractor: TurnExtractor): void {
    this._turnExtractor = extractor;
  }

  /**
   * Bind the turn extractor to a session for per-turn extraction.
   *
   * Safe to call when no turn extractor is set (no-op).
   */
  bindSession(session: AgentSession): void {
    this._turnExtractor?.bindSession(session);
  }

  /**
   * Close the store and dispose the turn extractor.
   *
   * Safe to call multiple times.
   */
  async dispose(): Promise<void> {
    this._turnExtractor?.dispose();
    this._turnExtractor = null;
    await this._store.close();
  }

  // ── prefetch (read path) ─────────────────────────────────────────────

  /**
   * Run the read-side prefetch pipeline.
   *
   * Embeds the message plus the previous assistant turn, searches the
   * episodic tier, filters by live-window eligibility, re-scores, and
   * renders survivors as `- fact` lines capped at `maxTokens`.
   *
   * Returns `{ context: null, hits: [] }` when nothing survives, so the
   * caller omits the `<memory-context>` block.
   */
  prefetchForMessage(
    text: string,
    prevAssistantTurn: string | null,
    liveWindow: LiveWindow,
  ): Promise<PrefetchResult> {
    return prefetch(this._store, text, prevAssistantTurn, liveWindow, this._config.prefetch);
  }

  // ── search (explicit recall) ─────────────────────────────────────────

  /**
   * Search both tiers for items matching the query.
   *
   * Unlike prefetch, this bypasses the live-window eligibility gate.  The
   * user asked, so the read-side invariant does not apply.
   */
  search(query: string, k?: number): Promise<ScoredItem[]> {
    return this._store.search(query, k ?? 10);
  }

  // ── CRUD (dashboard) ─────────────────────────────────────────────────

  /** List items with optional tier, tags, and pagination filters. */
  listItems(opts?: {
    tier?: MemoryTier;
    tags?: MemoryTag[];
    limit?: number;
    offset?: number;
  }): Promise<MemoryItem[]> {
    return this._store.list(opts);
  }

  /**
   * Upsert a memory item.
   *
   * When `item.id` is set, the store updates the existing item.  Otherwise
   * a new item is created with a generated id and timestamps.
   */
  upsertItem(
    item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<MemoryItem> {
    return this._store.upsert(item);
  }

  /** Delete a memory item by id.  No-op when the id does not exist. */
  deleteItem(id: string): Promise<void> {
    return this._store.delete(id);
  }

  // ── accessors ────────────────────────────────────────────────────────

  /** The underlying memory store.  Exposed for tool creation. */
  get store(): MemoryStore {
    return this._store;
  }

  /** The embedding provider. */
  get embeddings(): EmbeddingProvider {
    return this._embeddings;
  }

  /** Memory configuration. */
  get config(): MemoryConfig {
    return this._config;
  }
}