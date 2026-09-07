/**
 * Seed data and prefetch integration for memory-backed eval runs.
 *
 * Maps each eval case id to the items that should be stored so the real
 * prefetch pipeline (embeddings → sqlite-vec → filtering → re-scoring)
 * generates the memory context dynamically instead of using hardcoded
 * strings.
 */

import { prefetch as prefetchFn } from '../memory/prefetch.js';
import type { MemoryStore, MemoryItem } from '../memory/types.js';
import type { MemoryConfig } from '../shared/types.js';
import type { LiveWindow } from '../core/window/types.js';
import type { EvalCase } from './types.js';

/**
 * Seed items for each memory-bait eval case.
 *
 * Each seed list produces a set of MemoryItems that are written to the
 * store before the case runs. The items mirror the hardcoded
 * memoryContext strings in the cases so that the real embedding model
 * retrieves them via semantic similarity.
 */
const SEED_MAP: Record<
  string,
  Array<Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> & { content: string }>
> = {
  'mem-dentist': [
    {
      tier: 'episodic',
      content: 'user has a dentist appointment on thursday at 14:00',
      tags: ['event'],
      importance: 8,
      entities: ['dentist'],
      sourceEntryId: null,
    },
    {
      tier: 'episodic',
      content: 'user dislikes the dentist',
      tags: ['preference'],
      importance: 6,
      entities: ['dentist'],
      sourceEntryId: null,
    },
  ],
  'mem-standing-desk': [
    {
      tier: 'episodic',
      content: 'user has back trouble from sitting all day and is considering a standing desk',
      tags: ['preference', 'project'],
      importance: 7,
      entities: ['back', 'standing desk'],
      sourceEntryId: null,
    },
  ],
  'mem-game-night': [
    {
      tier: 'episodic',
      content: 'user has board game night with friends most fridays',
      tags: ['event'],
      importance: 5,
      entities: ['board game', 'friends'],
      sourceEntryId: null,
    },
  ],
  'mem-earned-recall': [
    {
      tier: 'episodic',
      content: 'user has back trouble from sitting all day and is considering a standing desk',
      tags: ['preference', 'project'],
      importance: 7,
      entities: ['back', 'standing desk'],
      sourceEntryId: null,
    },
  ],
};

/**
 * Get the seed items for a given case id, or undefined when none.
 */
export function getSeedItems(
  caseId: string,
): Array<Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> & { content: string }> | undefined {
  return SEED_MAP[caseId];
}

/**
 * Check if a case id has seed data.
 */
export function hasSeedItems(caseId: string): boolean {
  return caseId in SEED_MAP;
}

/**
 * Seed the store with items for a given case, replacing any existing
 * items first.
 *
 * @param store  The memory store to seed.
 * @param caseId The eval case id to seed for.
 */
export async function seedStore(store: MemoryStore, caseId: string): Promise<void> {
  const items = SEED_MAP[caseId];
  if (items === undefined) return;

  // Clear the store — delete all existing items.
  for (const item of await store.list()) {
    await store.delete(item.id);
  }

  // Insert seed items.
  for (const item of items) {
    await store.upsert(item);
  }
}

/**
 * Run the prefetch pipeline for a given eval case.
 *
 * Seeds the store first, then calls the real prefetch function.
 * Returns the memory context string (or null if prefetch returns nothing).
 *
 * The live window allows everything (boundaryEntryId=null means
 * isLive returns false for all sourceEntryIds that are null, which
 * our seed items are).
 *
 * @param store    The memory store (already seeded).
 * @param cfg      The memory prefetch config.
 * @param evalCase The eval case to prefetch for.
 */
export async function runPrefetchForCase(
  store: MemoryStore,
  cfg: MemoryConfig['prefetch'],
  evalCase: EvalCase,
): Promise<string | null> {
  // Seed first, then prefetch.
  await seedStore(store, evalCase.id);

  const liveWindow: LiveWindow = {
    boundaryEntryId: null,
    isLive: () => false, // Allow everything — no live window restriction.
  };

  const result = await prefetchFn(
    store,
    evalCase.message,
    null, // No previous assistant turn in eval.
    liveWindow,
    cfg,
  );

  return result.context;
}
