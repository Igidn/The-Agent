import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { EmbeddingProvider, MemoryItem, MemoryTag, MemoryStore } from './types.js';
import type { CompactionEvent } from '../core/window/types.js';
import {
  MemoryCompactionSink,
  chunkSummary,
  type ExtractFactsFn,
  type IngestFactFn,
  type ConsolidateFn,
} from './sink.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AgentMessage for tests. */
function droppedMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** Build a CompactionEvent for tests. */
function makeEvent(overrides?: Partial<CompactionEvent>): CompactionEvent {
  return {
    summary: overrides?.summary ?? 'This is the rolling summary of the conversation so far.',
    previousSummaries: overrides?.previousSummaries ?? [],
    droppedMessages: overrides?.droppedMessages ?? [],
    firstKeptEntryId: overrides?.firstKeptEntryId ?? 'entry-100',
    tokensBefore: overrides?.tokensBefore ?? 40000,
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
  };
}

/** In-memory store stub that records all upserted items. */
function createStore(): MemoryStore & { items: MemoryItem[] } {
  const items: MemoryItem[] = [];
  let nextId = 1;

  return {
    items,

    async upsert(
      input: Partial<MemoryItem> & { content: string; tier: string; tags: MemoryTag[] },
    ): Promise<MemoryItem> {
      const now = new Date().toISOString();
      const existing = items.find((i) => i.id === input.id);
      if (existing) {
        Object.assign(existing, input, { updatedAt: now });
        return existing;
      }
      const item: MemoryItem = {
        id: `mem_${nextId++}`,
        tier: input.tier as 'episodic' | 'profile',
        content: input.content,
        tags: input.tags ?? [],
        entities: input.entities,
        importance: input.importance ?? 0,
        sourceEntryId: input.sourceEntryId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      items.push(item);
      return item;
    },

    async get(id: string): Promise<MemoryItem | null> {
      return items.find((i) => i.id === id) ?? null;
    },

    async list(): Promise<MemoryItem[]> {
      return items;
    },

    async delete(id: string): Promise<void> {
      const idx = items.findIndex((i) => i.id === id);
      if (idx >= 0) items.splice(idx, 1);
    },

    async search(): Promise<[]> {
      return [];
    },

    async close(): Promise<void> {},
  } as unknown as MemoryStore & { items: MemoryItem[] };
}

// ---------------------------------------------------------------------------
// chunkSummary
// ---------------------------------------------------------------------------

test('chunkSummary returns empty array for empty string', () => {
  assert.deepEqual(chunkSummary(''), []);
});

test('chunkSummary returns the text as-is when shorter than target', () => {
  const text = 'Short text.';
  assert.deepEqual(chunkSummary(text, 100), [text]);
});

test('chunkSummary splits on sentence boundaries', () => {
  const text =
    'First sentence about preferences. Second sentence about projects. ' +
    'Third sentence about events. Fourth sentence about people.';
  const chunks = chunkSummary(text, 50);
  assert.ok(chunks.length >= 2);
  // Each chunk should end with a complete sentence
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 70); // slightly over target due to sentence boundary
    assert.ok(
      /[.!?]$/.test(chunk),
      `chunk should end with sentence-ending punctuation: "${chunk}"`,
    );
  }
});

test('chunkSummary joins all content back together', () => {
  const text =
    'Sentence one here. Sentence two here. Sentence three here. ' +
    'Sentence four here. Sentence five here. Sentence six here.';
  const chunks = chunkSummary(text, 40);
  const rejoined = chunks.join(' ');
  // Every original sentence should be present
  assert.ok(rejoined.includes('Sentence one here'));
  assert.ok(rejoined.includes('Sentence six here'));
});

test('chunkSummary handles single character texts', () => {
  assert.deepEqual(chunkSummary('A'), ['A']);
});

test('chunkSummary handles text with no sentence boundaries', () => {
  const text =
    'this is a long string with no sentence boundaries whatsoever ' +
    'it just keeps going without any punctuation at all which makes it ' +
    'a single block that must be split by word boundary fallback';
  const chunks = chunkSummary(text, 30);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(' '), text);
});

test('chunkSummary handles multiple newlines as separators', () => {
  const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
  const chunks = chunkSummary(text, 30);
  assert.ok(chunks.length >= 2);
});

// ---------------------------------------------------------------------------
// MemoryCompactionSink — recordCompaction
// ---------------------------------------------------------------------------

test('sink extracts facts from dropped messages and ingests them', async () => {
  const store = createStore();
  const extracted: Array<{ content: string; tags: MemoryTag[]; importance: number }> = [
    { content: 'User likes TypeScript', tags: ['preference'], importance: 7 },
    { content: 'User is building a memory service', tags: ['project'], importance: 8 },
  ];
  const ingested: Array<{ fact: unknown; sourceEntryId: string | null }> = [];

  const extractFacts: ExtractFactsFn = async (messages) => {
    assert.equal(messages.length, 2);
    return extracted;
  };

  const ingestFact: IngestFactFn = async (fact, sourceEntryId) => {
    ingested.push({ fact, sourceEntryId });
  };

  let consolidated = false;
  const consolidate: ConsolidateFn = async () => {
    consolidated = true;
  };

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  const event = makeEvent({
    droppedMessages: [
      droppedMessage('I really like TypeScript'),
      droppedMessage("I'm working on a memory service"),
    ],
  });

  await sink.recordCompaction(event);

  // Both facts should have been ingested
  assert.equal(ingested.length, 2);
  assert.equal(ingested[0].fact, extracted[0]);
  assert.equal(ingested[1].fact, extracted[1]);
  // sourceEntryId is always null (compacted segment is no longer live)
  assert.equal(ingested[0].sourceEntryId, null);
  assert.equal(ingested[1].sourceEntryId, null);
  // Consolidation should have been called
  assert.equal(consolidated, true);
});

test('sink persists rolling summary chunks as episodic items', async () => {
  const store = createStore();

  const extractFacts: ExtractFactsFn = async () => [];
  const ingestFact: IngestFactFn = async () => {};
  const consolidate: ConsolidateFn = async () => {};

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  const event = makeEvent({
    previousSummaries: [
      'Old rolling summary covering earlier topics.',
      'Middle summary that adds more context.',
    ],
    // The SDK merges previous summaries into the epoch summary (update
    // prompt), so this summary already covers the old content.
    summary:
      'Merged latest summary of the conversation segment. It covers earlier topics and adds more context.',
    droppedMessages: [],
  });

  await sink.recordCompaction(event);

  // Summary chunks should have been stored as episodic items with tags ["summary"]
  const summaryItems = store.items.filter((i) => i.tags.includes('summary' as MemoryTag));
  assert.ok(summaryItems.length > 0, 'should have at least one summary item');

  for (const item of summaryItems) {
    assert.equal(item.tier, 'episodic');
    assert.ok(item.tags.includes('summary' as MemoryTag));
    assert.equal(item.sourceEntryId, null);
    assert.equal(item.importance, 5);
  }

  // Only the epoch's own summary is stored; previousSummaries are already
  // contained in it and must not be re-embedded as duplicates.
  const fullStored = summaryItems.map((i) => i.content).join(' ');
  assert.ok(fullStored.includes('Merged latest summary'));
  assert.ok(
    !fullStored.includes('Old rolling summary covering earlier topics'),
    'previous summaries should not be re-stored verbatim',
  );
});

test('sink skips extraction when there are no dropped messages', async () => {
  const store = createStore();
  let extractionCalled = false;

  const extractFacts: ExtractFactsFn = async () => {
    extractionCalled = true;
    return [];
  };
  const ingestFact: IngestFactFn = async () => {};
  const consolidate: ConsolidateFn = async () => {};

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  await sink.recordCompaction(makeEvent({ droppedMessages: [] }));

  assert.equal(extractionCalled, false, 'should not extract when no messages');
});

test('sink skips summary persist when both chains are empty', async () => {
  const store = createStore();

  const extractFacts: ExtractFactsFn = async () => [];
  const ingestFact: IngestFactFn = async () => {};
  const consolidate: ConsolidateFn = async () => {};

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  await sink.recordCompaction(
    makeEvent({
      previousSummaries: [],
      summary: '',
    }),
  );

  assert.equal(store.items.length, 0, 'no items should be stored');
});

test('sink swallows extraction errors without throwing', async () => {
  const store = createStore();

  const extractFacts: ExtractFactsFn = async () => {
    throw new Error('LLM unavailable');
  };
  const ingestFact: IngestFactFn = async () => {};
  let consolidated = false;
  const consolidate: ConsolidateFn = async () => {
    consolidated = true;
  };

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  const event = makeEvent({
    droppedMessages: [droppedMessage('important fact')],
  });

  // Must not throw
  await sink.recordCompaction(event);

  // Consolidation should still run
  assert.equal(consolidated, true);
});

test('sink swallows ingest errors and continues with remaining facts', async () => {
  const store = createStore();
  const goodFact = { content: 'Good fact', tags: ['event'] as MemoryTag[], importance: 5 };

  let callCount = 0;
  const ingestFact: IngestFactFn = async (fact) => {
    callCount++;
    if (callCount === 1) throw new Error('storage full');
    // Second call succeeds
  };

  const extractFacts: ExtractFactsFn = async () => [goodFact, goodFact];
  const consolidate: ConsolidateFn = async () => {};

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  await sink.recordCompaction(
    makeEvent({
      droppedMessages: [droppedMessage('hi'), droppedMessage('bye')],
    }),
  );

  assert.equal(callCount, 2, 'both facts should have been attempted');
});

test('sink swallows summary upsert errors and continues', async () => {
  // Create a store that throws on upsert
  const store = createStore();
  const originalUpsert = store.upsert;
  let upsertCount = 0;
  const throwingUpsert: MemoryStore['upsert'] = async (input: any) => {
    upsertCount++;
    if (upsertCount <= 2) throw new Error('disk full'); // First two summary writes fail
    return originalUpsert(input);
  };
  store.upsert = throwingUpsert;

  const extractFacts: ExtractFactsFn = async () => [];
  const ingestFact: IngestFactFn = async () => {};
  const consolidate: ConsolidateFn = async () => {};

  const sink = new MemoryCompactionSink(
    store as MemoryStore,
    extractFacts,
    ingestFact,
    consolidate,
  );

  // Build enough text to produce at least 3 chunks with default targetChars=1000
  const sentences = [
    'First summary sentence about preferences that is a bit longer to describe something.',
    'Second summary sentence about project milestones and timelines.',
    'Third summary sentence about events and meetings with the team.',
    'Fourth summary sentence about people the user interacted with today.',
    'Fifth summary sentence about corrections to previous assumptions.',
    'Sixth summary sentence about project goals and deliverables.',
    'Seventh summary sentence about preferences for tools and workflows.',
    'Eighth summary sentence about events planned for next week.',
    'Ninth summary sentence about people mentioned in conversation.',
    'Tenth summary sentence about corrections to earlier decisions.',
  ];
  const longSummary = sentences.join(' ');
  // Three copies = ~3000 chars, should produce ~3 chunks
  const fullSummary = [longSummary, longSummary, longSummary].join('\n\n');

  await sink.recordCompaction(
    makeEvent({
      previousSummaries: [fullSummary, fullSummary],
      summary: fullSummary,
    }),
  );

  // Should have continued upserting after errors — at least 3 calls attempted
  assert.ok(upsertCount >= 3, `expected >=3 upserts, got ${upsertCount}`);

  // The third call (and beyond) should have succeeded
  const summaryItems = store.items.filter((i) => i.tags.includes('summary' as MemoryTag));
  assert.ok(summaryItems.length > 0, 'some summary items should have been stored');
});

test('sink swallows consolidation errors without throwing', async () => {
  const store = createStore();

  const extractFacts: ExtractFactsFn = async () => [];
  const ingestFact: IngestFactFn = async () => {};
  const consolidate: ConsolidateFn = async () => {
    throw new Error('consolidation failed');
  };

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  await sink.recordCompaction(makeEvent());

  // Must not throw — errors are logged and swallowed
});

test('sink calls consolidation after extraction and summary persist', async () => {
  const store = createStore();
  const callOrder: string[] = [];

  const extractFacts: ExtractFactsFn = async () => {
    callOrder.push('extract');
    return [{ content: 'test fact', tags: ['event'] as MemoryTag[], importance: 3 }];
  };
  const ingestFact: IngestFactFn = async () => {
    callOrder.push('ingest');
  };
  const consolidate: ConsolidateFn = async () => {
    callOrder.push('consolidate');
  };

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  // At least one dropped message and some summary to ensure all branches run
  await sink.recordCompaction(
    makeEvent({
      droppedMessages: [droppedMessage('test')],
      summary: 'Test summary that is long enough to store.',
    }),
  );

  assert.deepEqual(callOrder, ['extract', 'ingest', 'consolidate']);
});

test('sink handles empty compaction event gracefully', async () => {
  const store = createStore();
  let called = false;

  const extractFacts: ExtractFactsFn = async () => {
    called = true;
    return [];
  };
  const ingestFact: IngestFactFn = async () => {};
  const consolidate: ConsolidateFn = async () => {};

  const sink = new MemoryCompactionSink(store, extractFacts, ingestFact, consolidate);

  await sink.recordCompaction(
    makeEvent({
      droppedMessages: [],
      previousSummaries: [],
      summary: '',
    }),
  );

  assert.equal(called, false);
  assert.equal(store.items.length, 0);
});
