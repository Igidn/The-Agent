import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Api, Model, Models, Usage, Message, AssistantMessage } from '@earendil-works/pi-ai';

import type {
  ExtractedFact,
  ExtractionDecision,
  MemoryItem,
  MemoryStore,
  MemoryTag,
  ScoredItem,
} from './types.js';
import { extractFacts, decideUpsert, ingestFact } from './extract.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixture: a minimal AgentMessage-like object with a user role. */
function userMessage(text: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  };
}

/** Fake Models.collection that returns a canned assistant reply. */
function fakeModels(cannedText: string, cannedUsage?: Usage): Models {
  const usage: Usage = cannedUsage ?? {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  return {
    async complete(_model: unknown, _context: unknown, _options?: unknown) {
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: cannedText }],
        usage,
        stopReason: 'stop' as const,
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o-mini' as const,
        timestamp: Date.now(),
      };
    },
  } as unknown as Models;
}

/** Fake Models that always throws. */
function failingModels(): Models {
  return {
    async complete() {
      throw new Error('provider unavailable');
    },
  } as unknown as Models;
}

const UNUSED_MODEL = undefined as unknown as Model<Api>;

function fakeModel(): Model<Api> {
  return { provider: 'openai', id: 'gpt-4o-mini' } as unknown as Model<Api>;
}

/** In-memory store stub for ingestFact tests.
 * search uses word-overlap + tag overlap to simulate kNN behavior.
 */
function createStore(
  items: MemoryItem[],
): MemoryStore & { searchCalls: unknown[]; upsertCalls: unknown[] } {
  const searchCalls: unknown[] = [];
  const upsertCalls: unknown[] = [];

  function wordOverlap(a: string, b: string): number {
    const wordsA = new Set(
      a
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((w) => w.length > 2),
    );
    const wordsB = new Set(
      b
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((w) => w.length > 2),
    );
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  function search(text: string, k: number, tiers?: string[]): Promise<ScoredItem[]> {
    searchCalls.push({ text, k, tiers });
    const matches = items
      .filter((item) => !tiers || tiers.includes(item.tier))
      .map((item) => {
        const overlap = wordOverlap(text, item.content);
        const tagOverlap = item.tags.length > 0 ? 1 : 0;
        const cosine = overlap * 0.8 + tagOverlap * 0.2;
        return {
          item,
          cosine: Math.min(1, cosine),
          score: (cosine * item.importance) / 10,
        };
      })
      .filter((s) => s.cosine > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return Promise.resolve(matches);
  }

  async function upsert(item: Partial<MemoryItem> & { content: string }): Promise<MemoryItem> {
    upsertCalls.push(item);
    const now = new Date().toISOString();
    const existing = items.find((i) => i.id === item.id);
    if (existing) {
      Object.assign(existing, item, { updatedAt: now });
      return existing;
    }
    const created: MemoryItem = {
      id: `mem_${items.length + 1}`,
      tier: item.tier ?? 'episodic',
      content: item.content,
      tags: item.tags ?? [],
      importance: item.importance ?? 5,
      sourceEntryId: item.sourceEntryId ?? null,
      entities: item.entities,
      createdAt: now,
      updatedAt: now,
    };
    items.push(created);
    return created;
  }

  async function get(id: string): Promise<MemoryItem | null> {
    return items.find((i) => i.id === id) ?? null;
  }

  async function list(): Promise<MemoryItem[]> {
    return items;
  }

  async function del(id: string): Promise<void> {
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) items.splice(idx, 1);
  }

  return {
    upsert,
    get,
    list,
    delete: del,
    search,
    close: async () => {},
    searchCalls,
    upsertCalls,
  } as unknown as MemoryStore & { searchCalls: unknown[]; upsertCalls: unknown[] };
}

// ---------------------------------------------------------------------------
// extractFacts
// ---------------------------------------------------------------------------

test('extractFacts returns empty array for empty messages', async () => {
  const result = await extractFacts([], UNUSED_MODEL, fakeModels('[]'));
  assert.deepEqual(result, []);
});

test('extractFacts returns parsed facts from a valid JSON response', async () => {
  const canned = JSON.stringify([
    { content: 'User likes TypeScript', tags: ['preference'], importance: 6 },
    { content: 'User is working on a memory service', tags: ['project'], importance: 8 },
  ]);

  const messages = [userMessage("I really like TypeScript and I'm building a memory service.")];
  const result = await extractFacts(messages, fakeModel(), fakeModels(canned));

  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'User likes TypeScript');
  assert.deepEqual(result[0].tags, ['preference']);
  assert.equal(result[0].importance, 6);
  assert.equal(result[1].content, 'User is working on a memory service');
  assert.deepEqual(result[1].tags, ['project']);
  assert.equal(result[1].importance, 8);
});

test('extractFacts strips markdown fences from LLM output', async () => {
  const canned =
    '```json\n[\n  {"content": "Test fact", "tags": ["event"], "importance": 5}\n]\n```';
  const result = await extractFacts(
    [userMessage('some conversation')],
    fakeModel(),
    fakeModels(canned),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].content, 'Test fact');
});

test('extractFacts returns empty array on provider failure', async () => {
  const result = await extractFacts([userMessage('hi')], fakeModel(), failingModels());
  assert.deepEqual(result, []);
});

test('extractFacts returns empty array when JSON is invalid', async () => {
  const result = await extractFacts(
    [userMessage('hi')],
    fakeModel(),
    fakeModels('not json at all'),
  );
  assert.deepEqual(result, []);
});

test('extractFacts filters out items with invalid importance or empty content', async () => {
  const canned = JSON.stringify([
    { content: '', tags: ['preference'], importance: 5 },
    { content: 'Valid fact', tags: ['person'], importance: 7 },
    { content: 'Bad importance', tags: ['event'], importance: 99 },
  ]);
  const result = await extractFacts([userMessage('hi')], fakeModel(), fakeModels(canned));

  // Only the valid fact passes the filter.
  assert.equal(result.length, 1);
  assert.equal(result[0].content, 'Valid fact');
});

test('extractFacts formats assistant and tool messages correctly', async () => {
  // The function should process mixed message types without crashing.
  const messages = [
    userMessage('Remember that I prefer short answers.'),
    assistantMessage("Sure, I'll keep it short."),
    {
      role: 'toolResult' as const,
      toolCallId: 'call_123',
      toolName: 'ls',
      content: [{ type: 'text' as const, text: 'ls output here' }],
      isError: false,
      timestamp: Date.now(),
    },
  ];

  const canned = JSON.stringify([
    { content: 'User prefers short answers', tags: ['preference'], importance: 7 },
  ]);

  const result = await extractFacts(messages as any, fakeModel(), fakeModels(canned));
  assert.equal(result.length, 1);
  assert.equal(result[0].content, 'User prefers short answers');
});

test('extractFacts passes the signal through to models.complete', async () => {
  const ac = new AbortController();
  ac.abort();

  // A models mock that verifies the signal is forwarded.
  let capturedSignal: AbortSignal | undefined;
  const models: Models = {
    async complete(_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) {
      capturedSignal = options?.signal;
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: '[]' }],
        usage: {} as Usage,
        stopReason: 'stop' as const,
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o-mini' as const,
        timestamp: Date.now(),
      };
    },
  } as unknown as Models;

  await extractFacts([userMessage('hi')], fakeModel(), models, ac.signal);
  assert.equal(capturedSignal?.aborted, true);
});

// ---------------------------------------------------------------------------
// decideUpsert
// ---------------------------------------------------------------------------

const SAMPLE_FACT: ExtractedFact = {
  content: 'User prefers dark mode in UI',
  tags: ['preference'],
  importance: 6,
};

const SAMPLE_CANDIDATES: ScoredItem[] = [
  {
    item: {
      id: 'mem_1',
      tier: 'episodic',
      content: 'User mentioned liking dark themes',
      tags: ['preference'],
      importance: 5,
      sourceEntryId: 'entry_1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    cosine: 0.85,
    score: 0.7,
  },
  {
    item: {
      id: 'mem_2',
      tier: 'episodic',
      content: 'User is working on a dashboard',
      tags: ['project'],
      importance: 8,
      sourceEntryId: 'entry_2',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    cosine: 0.3,
    score: 0.2,
  },
];

test('decideUpsert parses ADD decision', async () => {
  const canned = '{"action": "ADD"}';
  const decision = await decideUpsert(
    SAMPLE_FACT,
    SAMPLE_CANDIDATES,
    fakeModel(),
    fakeModels(canned),
  );
  assert.equal(decision.action, 'ADD');
  assert.equal(decision.targetId, undefined);
});

test('decideUpsert parses UPDATE decision with targetId', async () => {
  const canned = '{"action": "UPDATE", "targetId": "mem_1"}';
  const decision = await decideUpsert(
    SAMPLE_FACT,
    SAMPLE_CANDIDATES,
    fakeModel(),
    fakeModels(canned),
  );
  assert.equal(decision.action, 'UPDATE');
  assert.equal(decision.targetId, 'mem_1');
});

test('decideUpsert parses DELETE decision', async () => {
  const canned = '{"action": "DELETE", "targetId": "mem_2"}';
  const decision = await decideUpsert(
    SAMPLE_FACT,
    SAMPLE_CANDIDATES,
    fakeModel(),
    fakeModels(canned),
  );
  assert.equal(decision.action, 'DELETE');
  assert.equal(decision.targetId, 'mem_2');
});

test('decideUpsert parses NOOP decision', async () => {
  const canned = '{"action": "NOOP"}';
  const decision = await decideUpsert(
    SAMPLE_FACT,
    SAMPLE_CANDIDATES,
    fakeModel(),
    fakeModels(canned),
  );
  assert.equal(decision.action, 'NOOP');
  assert.equal(decision.targetId, undefined);
});

test('decideUpsert degrades to ADD on parse failure', async () => {
  const decision = await decideUpsert(
    SAMPLE_FACT,
    SAMPLE_CANDIDATES,
    fakeModel(),
    fakeModels('garbage'),
  );
  assert.equal(decision.action, 'ADD');
});

test('decideUpsert degrades to ADD on provider failure', async () => {
  const decision = await decideUpsert(SAMPLE_FACT, SAMPLE_CANDIDATES, fakeModel(), failingModels());
  assert.equal(decision.action, 'ADD');
});

test('decideUpsert handles empty candidates', async () => {
  const canned = '{"action": "ADD"}';
  const decision = await decideUpsert(SAMPLE_FACT, [], fakeModel(), fakeModels(canned));
  assert.equal(decision.action, 'ADD');
});

// ---------------------------------------------------------------------------
// ingestFact
// ---------------------------------------------------------------------------

test('ingestFact inserts a novel fact as episodic', async () => {
  const items: MemoryItem[] = [];
  const store = createStore(items);

  await ingestFact(
    store,
    { content: 'User loves functional programming', tags: ['preference'], importance: 7 },
    'entry_10',
  );

  // Should have called search then upsert.
  assert.equal(store.upsertCalls.length, 1);
  const call = store.upsertCalls[0] as Record<string, unknown>;
  assert.equal(call.tier, 'episodic');
  assert.equal(call.content, 'User loves functional programming');
  assert.deepEqual(call.tags, ['preference']);
  assert.equal(call.importance, 7);
  assert.equal(call.sourceEntryId, 'entry_10');
});

test('ingestFact skips insertion when fact is already covered', async () => {
  const items: MemoryItem[] = [
    {
      id: 'mem_1',
      tier: 'episodic',
      content: 'User said they love functional programming',
      tags: ['preference'],
      importance: 6,
      sourceEntryId: 'entry_1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
  const store = createStore(items);

  await ingestFact(
    store,
    { content: 'User loves functional programming', tags: ['preference'], importance: 7 },
    'entry_10',
  );

  // The existing item has tag+content overlap → skip.
  assert.equal(store.upsertCalls.length, 0);
});

test('ingestFact updates existing item on correction', async () => {
  const items: MemoryItem[] = [
    {
      id: 'mem_1',
      tier: 'episodic',
      content: 'User said they prefer dark mode',
      tags: ['preference'],
      importance: 5,
      sourceEntryId: 'entry_1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
  const store = createStore(items);

  await ingestFact(
    store,
    {
      content: 'User prefers light mode, not dark',
      tags: ['preference', 'correction'],
      importance: 8,
    },
    'entry_10',
  );

  // Should update the matched item.
  assert.equal(store.upsertCalls.length, 1);
  const call = store.upsertCalls[0] as Record<string, unknown>;
  assert.equal(call.id, 'mem_1');
  assert.equal(call.content, 'User prefers light mode, not dark');
  assert.equal(call.importance, 8); // max(5, 8)
  // Tags should be merged: ["preference", "correction"]
  assert.deepEqual((call.tags as string[]).sort(), ['correction', 'preference']);
});

test('ingestFact handles empty search results gracefully', async () => {
  const items: MemoryItem[] = [];
  const store = createStore(items);

  // No items in store at all.
  await ingestFact(store, { content: 'Some fact', tags: ['event'], importance: 3 }, 'entry_20');

  assert.equal(store.upsertCalls.length, 1);
  assert.equal((store.upsertCalls[0] as Record<string, unknown>).content, 'Some fact');
});

test('ingestFact uses correct tier for novel episodic insertions', async () => {
  const items: MemoryItem[] = [];
  const store = createStore(items);

  await ingestFact(
    store,
    { content: 'Met Alice at the meetup', tags: ['person', 'event'], importance: 6 },
    'entry_5',
  );

  assert.equal(store.upsertCalls.length, 1);
  assert.equal((store.upsertCalls[0] as Record<string, unknown>).tier, 'episodic');
});

test('ingestFact with sourceEntryId null still inserts', async () => {
  const items: MemoryItem[] = [];
  const store = createStore(items);

  await ingestFact(
    store,
    { content: 'Standalone fact', tags: ['preference'], importance: 4 },
    null,
  );

  assert.equal(store.upsertCalls.length, 1);
  assert.equal((store.upsertCalls[0] as Record<string, unknown>).sourceEntryId, null);
});
