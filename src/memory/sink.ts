import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { CompactionEvent, CompactionSink } from '../core/window/types.js';
import type {
  EmbeddingProvider,
  ExtractedFact,
  MemoryItem,
  MemoryTag,
  MemoryStore,
} from './types.js';

/**
 * Bound extract function: takes messages and returns extracted facts.
 *
 * The caller (main.ts) binds the model and models dependency before passing
 * it in, so the sink never needs to know about the LLM.
 */
export type ExtractFactsFn = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<ExtractedFact[]>;

/**
 * Bound ingest function: writes a single extracted fact into the store.
 *
 * Deduplication and correction merge are handled by the bound function
 * (the impl from extract.ts), not by the sink.
 */
export type IngestFactFn = (fact: ExtractedFact, sourceEntryId: string | null) => Promise<void>;

/**
 * Bound consolidation function: called after the sink finishes writing.
 *
 * Receives nothing because the store is already captured at binding time
 * in main.ts; the sink just signals that compaction output landed.
 */
export type ConsolidateFn = () => Promise<void>;

/**
 * Split text into chunks at sentence boundaries.
 *
 * Each chunk is a string of roughly `targetChars` characters, split on
 * sentence-end punctuation (`.`, `!`, `?`) followed by a space or newline.
 * Falls back to word-boundary split when no sentence boundary is found
 * within the target range.
 *
 * Exported for testing.
 */
export function chunkSummary(text: string, targetChars = 1000): string[] {
  if (text.length === 0) return [];
  if (text.length <= targetChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    if (start + targetChars >= text.length) {
      chunks.push(text.slice(start).trim());
      break;
    }

    const end = text.length;
    const searchEnd = Math.min(start + targetChars, end);

    // Look backward from the target for a sentence boundary
    // Split on . ! ? followed by space or newline (non-greedy)
    const segment = text.slice(start, searchEnd);
    let lastBoundary = -1;
    for (let i = segment.length - 1; i >= 0; i--) {
      if (/[.!?]/.test(segment[i])) {
        if (i + 1 >= segment.length || /\s/.test(segment[i + 1])) {
          lastBoundary = i + 1;
          break;
        }
      }
    }

    if (lastBoundary > 0) {
      chunks.push(segment.slice(0, lastBoundary).trim());
      start += lastBoundary;
    } else {
      // No sentence boundary found — fall back to word boundary
      const lastSpace = segment.lastIndexOf(' ');
      if (lastSpace > 0) {
        chunks.push(segment.slice(0, lastSpace).trim());
        start += lastSpace;
      } else {
        // No word boundary either — hard split
        chunks.push(segment.trim());
        start = searchEnd;
      }
    }

    // Skip separator whitespace
    while (start < text.length && /\s/.test(text[start])) {
      start++;
    }
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Compaction sink that re-extracts facts from dropped messages, persists
 * the rolling summary as episodic memory, and fires consolidation.
 *
 * This is the deliberate redundancy pass described in the memory design:
 * per-turn extraction may miss facts (fire-and-forget, best-effort), so
 * the compaction boundary offers a second chance to capture anything
 * important from the segment that just left the live window.
 *
 * Every write error is logged and swallowed — losing an index write must
 * never fail the compaction that produced it (same posture as the audit
 * and window-manager sinks).
 */
export class MemoryCompactionSink implements CompactionSink {
  /**
   * @param store        Open memory store (Task 3).
   * @param extractFacts Bound extraction function (model pre-bound).
   * @param ingestFact   Bound ingest function (dedupe pre-bound).
   * @param consolidate  Bound consolidation function, called after the
   *                     sink finishes writing.
   * @param embeddings   Optional embedding provider for batch-embedding
   *                     summary chunks. When omitted, the store's own
   *                     upsert path handles embedding.
   */
  constructor(
    private readonly _store: MemoryStore,
    private readonly _extractFacts: ExtractFactsFn,
    private readonly _ingestFact: IngestFactFn,
    private readonly _consolidate: ConsolidateFn,
    private readonly _embeddings?: EmbeddingProvider,
  ) {}

  /**
   * Receive a compaction event and process it.
   *
   * Steps:
   * 1. Extract facts from the dropped segment (redundancy pass).
   * 2. Ingest each extracted fact into the store.
   * 3. Chunk the rolling summary (previous summaries + current summary)
   *    and store each chunk as an episodic item with tags ["summary"].
   * 4. Fire consolidation.
   *
   * All errors are caught, logged, and swallowed. A failed memory write
   * must never block the compaction that produced it.
   */
  async recordCompaction(event: CompactionEvent): Promise<void> {
    await this._processDroppedMessages(event);
    await this._persistRollingSummary(event);
    await this._fireConsolidation();
  }

  private async _processDroppedMessages(event: CompactionEvent): Promise<void> {
    if (event.droppedMessages.length === 0) return;

    try {
      const facts = await this._extractFacts(event.droppedMessages);

      for (const fact of facts) {
        try {
          // These facts come from the dropped (compacted) segment, so
          // sourceEntryId is null — they are no longer live in the window
          // and are eligible for retrieval.
          await this._ingestFact(fact, null);
        } catch (err) {
          console.warn(
            `Compaction sink: fact ingest failed (fact="${fact.content.slice(0, 80)}")`,
            err,
          );
        }
      }
    } catch (err) {
      console.warn('Compaction sink: fact extraction from dropped messages failed', err);
    }
  }

  private async _persistRollingSummary(event: CompactionEvent): Promise<void> {
    // The SDK merges previousSummary into the new epoch summary (its update
    // prompt), so `event.summary` already contains everything the older
    // rolling summaries did. Re-storing `previousSummaries` would re-embed
    // all past summary content at every epoch — O(N²) duplicate chunks in
    // the index. Only the epoch's own summary is stored.
    const { summary } = event;

    if (summary.length === 0) return;

    const chunks = chunkSummary(summary);

    for (const chunk of chunks) {
      try {
        await this._store.upsert({
          tier: 'episodic',
          content: chunk,
          tags: ['summary' as MemoryTag],
          entities: undefined,
          importance: 5, // Neutral importance for summary material
          sourceEntryId: null, // Not linked to a live entry
        });
      } catch (err) {
        console.warn(
          `Compaction sink: summary chunk upsert failed (chunk="${chunk.slice(0, 80)}")`,
          err,
        );
      }
    }
  }

  private async _fireConsolidation(): Promise<void> {
    try {
      await this._consolidate();
    } catch (err) {
      console.warn('Compaction sink: consolidation callback failed', err);
    }
  }
}
