import type { MemoryConfig } from '../shared/types.js';
import type { LiveWindow } from '../core/window/types.js';
import type { MemoryStore, PrefetchResult, ScoredItem } from './types.js';

/**
 * Build the query text from the current message and the previous assistant
 * turn.  Concatenating both lets the vector search resolve anaphora like
 * "what about that?" even when the user message is short.
 */
function buildQuery(message: string, prevAssistantTurn: string | null): string {
  if (prevAssistantTurn === null || prevAssistantTurn.trim().length === 0) {
    return message;
  }
  return `${prevAssistantTurn}\n${message}`;
}

/**
 * Rough token count: chars / 4, matching the heuristic the SDK uses.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Check whether the query text contains any entity name from the item
 * (case-insensitive word-boundary check).
 *
 * This prevents vibe-matching: an item about "games night with my friends"
 * is not surfaced for a query about "gaming" just because the vector
 * similarity is barely above zero, unless the item shares an entity name
 * with the query text.
 */
function hasEntityOverlap(queryText: string, item: { entities?: string[] }): boolean {
  if (!item.entities || item.entities.length === 0) return false;

  const lowerQuery = queryText.toLowerCase();
  return item.entities.some((entity) => {
    const lower = entity.toLowerCase();
    // Check word boundary: entity must appear as a whole word in the query.
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`);
    return regex.test(lowerQuery);
  });
}

/**
 * Run the read-side prefetch pipeline.
 *
 * Five steps:
 * 1. Embed the message plus the previous assistant turn.
 * 2. Top-k search (both tiers) via vector similarity.
 * 3. Exclude items whose `sourceEntryId` is still live in the window.
 * 4. Filter by tag/entity overlap with the query OR a strict cosine cutoff.
 * 5. Re-score candidates (cosine + recency + importance), then threshold.
 * 6. Render survivors as `- fact` lines, capped at `maxTokens`.
 *
 * Returns `{ context: null, hits: [] }` when nothing survives, so the
 * caller omits the `<memory-context>` block and the turn pays nothing extra.
 */
export async function prefetch(
  store: MemoryStore,
  message: string,
  prevAssistantTurn: string | null,
  liveWindow: LiveWindow,
  cfg: MemoryConfig['prefetch'],
): Promise<PrefetchResult> {
  const queryText = buildQuery(message, prevAssistantTurn);
  if (queryText.trim().length === 0) {
    return { context: null, hits: [] };
  }

  const allResults = await store.search(queryText, cfg.topK, ['episodic']);

  if (allResults.length === 0) {
    return { context: null, hits: [] };
  }

  const eligible = allResults.filter(
    (r) => r.item.sourceEntryId === null || !liveWindow.isLive(r.item.sourceEntryId),
  );

  if (eligible.length === 0) {
    return { context: null, hits: [] };
  }

  const filtered = eligible.filter((r) => {
    if (r.cosine >= cfg.strictCosine) return true;
    return hasEntityOverlap(queryText, r.item);
  });

  if (filtered.length === 0) {
    return { context: null, hits: [] };
  }

  const scored = filtered
    .map((r) => ({
      item: r.item,
      cosine: r.cosine,
      score: (() => {
        const normalizedImportance = Math.min(r.item.importance / 10, 1);
        const ageMs = Date.now() - new Date(r.item.updatedAt).getTime();
        const ageDays = ageMs / 86_400_000;
        const recency = Math.max(0, 1 - ageDays / 30);
        return r.cosine * 0.5 + recency * 0.25 + normalizedImportance * 0.25;
      })(),
    }))
    .filter((r) => r.score >= cfg.scoreThreshold);

  if (scored.length === 0) {
    return { context: null, hits: [] };
  }

  scored.sort((a, b) => b.score - a.score);

  const lines: string[] = [];
  let totalTokens = 0;

  for (const result of scored) {
    const line = `- ${result.item.content}`;
    const lineTokens = estimateTokens(line);

    if (totalTokens + lineTokens > cfg.maxTokens && lines.length > 0) {
      break; // Don't exceed the budget; at least one line is already in.
    }

    lines.push(line);
    totalTokens += lineTokens;
  }

  if (lines.length === 0) {
    return { context: null, hits: [] };
  }

  return {
    context: lines.join('\n'),
    hits: scored,
  };
}
