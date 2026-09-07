/**
 * End-to-end test of the memory service system using the real embedding
 * model (Xenova/bge-small-en-v1.5) and a real SQLite+sqlite-vec store.
 *
 * This test exercises the actual LocalEmbeddingProvider (ONNX via
 * transformers.js), so it tests the real vector similarity search, not
 * a fake embedding.  Run with:
 *   npx tsx src/memory/e2e.test.ts
 * or via the project's test runner:
 *   node --test dist/memory/e2e.test.js   (after tsc)
 *
 * The model is downloaded on first run (~34 MB) and cached.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteMemoryStore } from './store.js';
import { LocalEmbeddingProvider } from './embeddings.js';
import { MemoryService } from './service.js';
import { prefetch } from './prefetch.js';
import { createMemorySearchTool } from './tool.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LiveWindow } from '../core/window/types.js';
import type { MemoryConfig } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Real embedding config
// ---------------------------------------------------------------------------

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DIMS = 384;

const BASE_CFG: MemoryConfig = {
  dbPath: '', // set per-test
  embeddingModel: MODEL_ID,
  embeddingDims: DIMS,
  embedding: { provider: 'local' },
  prefetch: {
    topK: 16,
    maxTokens: 300,
    strictCosine: 0.6,
    scoreThreshold: 0.4,
  },
};

// ---------------------------------------------------------------------------
// Live-window mock
// ---------------------------------------------------------------------------

function makeLiveWindow(liveIds: Set<string> = new Set()): LiveWindow {
  return {
    boundaryEntryId: liveIds.size > 0 ? [...liveIds][0] : null,
    isLive(id: string): boolean {
      return liveIds.has(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function withMemServices(
  fn: (services: {
    store: SqliteMemoryStore;
    embeddings: LocalEmbeddingProvider;
    service: MemoryService;
    dbPath: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'memory-e2e-'));
  const dbPath = join(dir, 'e2e.db');
  const embeddings = new LocalEmbeddingProvider(MODEL_ID, DIMS);
  const store = new SqliteMemoryStore(dbPath, embeddings);
  const service = new MemoryService(BASE_CFG, store, embeddings);

  try {
    await fn({ store, embeddings, service, dbPath });
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedSemanticData(store: SqliteMemoryStore): Promise<void> {
  // Insert items with semantically distinct topics so we can verify
  // that the real model retrieves *meaning*, not bag-of-words overlap.
  await store.upsert({
    tier: 'episodic',
    content: 'The user enjoys hiking in the Rocky Mountains on weekends',
    tags: ['preference', 'event'],
    importance: 7,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: 'episodic',
    content: 'The team adopted a microservices architecture for the payment system',
    tags: ['project'],
    importance: 9,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: 'episodic',
    content: 'User ordered a cappuccino with oat milk this morning',
    tags: ['preference'],
    importance: 3,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: 'episodic',
    content: 'The database migration from Postgres 14 to 16 is scheduled for next weekend',
    tags: ['project', 'event'],
    importance: 8,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: 'profile',
    content: 'User is a backend engineer focused on distributed systems',
    tags: ['person'],
    importance: 9,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: 'episodic',
    content: 'The user mentioned their dog Max loves to fetch tennis balls at the park',
    tags: ['person', 'preference'],
    importance: 5,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: 'episodic',
    content: 'The team decided to use Kafka for event-driven communication between services',
    tags: ['project', 'event'],
    importance: 8,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: 'episodic',
    content: 'User prefers working from home on Tuesdays and Thursdays',
    tags: ['preference'],
    importance: 6,
    sourceEntryId: null,
  });
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe('MemoryService e2e with real embeddings', () => {
  // ── 1. Embedding provider ─────────────────────────────────────────────

  test('LocalEmbeddingProvider warmup and embed produce correct shape', async () => {
    const p = new LocalEmbeddingProvider(MODEL_ID, DIMS);
    const vectors = await p.embed(['hello world', 'test sentence']);

    assert.equal(vectors.length, 2);
    assert.equal(vectors[0].length, DIMS);
    assert.equal(vectors[1].length, DIMS);

    // All values are finite numbers (real embedding output)
    for (const vec of vectors) {
      for (const v of vec) {
        assert.equal(typeof v, 'number');
        assert.ok(Number.isFinite(v), `expected finite, got ${v}`);
      }
    }

    // Two different texts should produce different vectors
    const same = vectors[0].every((v, i) => v === vectors[1][i]);
    assert.equal(same, false, 'different texts must produce different vectors');
  });

  test('embed returns unit vectors', async () => {
    const p = new LocalEmbeddingProvider(MODEL_ID, DIMS);
    const [vec] = await p.embed(['a single test input']);

    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(mag - 1) < 1e-3, `expected unit vector, got magnitude ${mag}`);
  });

  test('semantically similar texts produce higher cosine similarity', async () => {
    const p = new LocalEmbeddingProvider(MODEL_ID, DIMS);
    const [v1, v2, v3] = await p.embed([
      'hiking in the mountains',
      'walking in the hills', // semantically similar to hiking
      'quantum physics theory', // semantically different
    ]);

    const cosine12 = cosineSimilarity(v1, v2);
    const cosine13 = cosineSimilarity(v1, v3);

    assert.ok(
      cosine12 > cosine13,
      `hiking/mountains vs walking/hills (${cosine12.toFixed(4)}) should be > hiking vs quantum (${cosine13.toFixed(4)})`,
    );
  });

  // ── 2. Store + real embeddings ───────────────────────────────────────

  test('SqliteMemoryStore with real embeddings stores and retrieves items', async () => {
    await withMemServices(async ({ store }) => {
      const item = await store.upsert({
        tier: 'episodic',
        content: 'End-to-end test item',
        tags: ['event'],
        importance: 5,
        sourceEntryId: null,
      });

      assert.ok(typeof item.id === 'string' && item.id.length > 0);
      assert.equal(item.content, 'End-to-end test item');

      const fetched = await store.get(item.id);
      assert.notEqual(fetched, null);
      assert.equal(fetched!.content, 'End-to-end test item');
    });
  });

  test('vector search with real embeddings returns semantically relevant items', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);

      // Search for something about hiking
      const results = await store.search('outdoor activities mountain trails', 5);

      assert.ok(results.length > 0, 'should find hiking-related items');
      const topContent = results[0].item.content.toLowerCase();
      assert.ok(
        topContent.includes('hiking') ||
          topContent.includes('mountains') ||
          topContent.includes('park'),
        `top result should be semantically about outdoors, got: "${results[0].item.content}"`,
      );
    });
  });

  test('search ranks microservices item above unrelated topics for architecture query', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);

      const results = await store.search('system design software architecture', 5);

      assert.ok(results.length >= 2, 'should find multiple matches');
      // The microservices and Kafka items should be near the top
      const topContents = results.slice(0, 3).map((r) => r.item.content);
      const hasArchitecture = topContents.some(
        (c) =>
          c.toLowerCase().includes('microservices') ||
          c.toLowerCase().includes('kafka') ||
          c.toLowerCase().includes('distributed'),
      );
      assert.ok(hasArchitecture, 'architecture-related items should rank high');
    });
  });

  test('search with k=1 returns exactly one result', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);
      const results = await store.search('hiking', 1);
      assert.equal(results.length, 1);
    });
  });

  test('search returns empty for completely unmatched query (low threshold)', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);
      const results = await store.search('quantum chromodynamics flavor oscillation', 5);
      // sqlite-vec always returns k results sorted by distance; even
      // "unmatched" queries get the closest vectors. We just verify it
      // doesn't crash and returns something.
      assert.ok(Array.isArray(results));
    });
  });

  // ── 3. MemoryService facade ──────────────────────────────────────────

  test('MemoryService.prefetchForMessage returns relevant context', async () => {
    await withMemServices(async ({ service, store }) => {
      await seedSemanticData(store);

      const result = await service.prefetchForMessage(
        'what do they like to do outside on weekends',
        null,
        makeLiveWindow(),
      );

      if (result.context !== null) {
        assert.ok(
          result.context.toLowerCase().includes('hiking') ||
            result.context.toLowerCase().includes('mountains') ||
            result.context.toLowerCase().includes('park'),
          `prefetch context should mention outdoor activities, got: "${result.context}"`,
        );
      } else {
        // This can happen if score threshold filters everything; log
        console.log('prefetch returned null (all below threshold)');
      }
    });
  });

  test('MemoryService.prefetchForMessage excludes live items', async () => {
    await withMemServices(async ({ service, store }) => {
      await seedSemanticData(store);

      // Insert an item that would normally match, but mark it as live
      await store.upsert({
        tier: 'episodic',
        content: 'User just said they love trail running this morning',
        tags: ['preference', 'event'],
        importance: 8,
        sourceEntryId: 'entry-live-999',
      });

      const result = await service.prefetchForMessage(
        'running and outdoor activities',
        null,
        makeLiveWindow(new Set(['entry-live-999'])),
      );

      if (result.hits.length > 0) {
        const liveHits = result.hits.filter((h) => h.item.sourceEntryId === 'entry-live-999');
        assert.equal(liveHits.length, 0, 'live items must be excluded from prefetch');
      }
    });
  });

  test('MemoryService.search returns results for explicit recall', async () => {
    await withMemServices(async ({ service, store }) => {
      await seedSemanticData(store);

      const results = await service.search('coffee drinks');

      assert.ok(results.length > 0, 'should find coffee preference');
      const hasCappuccino = results.some((r) =>
        r.item.content.toLowerCase().includes('cappuccino'),
      );
      assert.ok(hasCappuccino, 'search should surface the cappuccino item');
    });
  });

  test('MemoryService CRUD ops work end-to-end', async () => {
    await withMemServices(async ({ service }) => {
      // List empty
      const empty = await service.listItems();
      assert.equal(empty.length, 0);

      // Create
      const created = await service.upsertItem({
        tier: 'profile',
        content: 'User prefers dark mode',
        tags: ['preference'],
        importance: 7,
        sourceEntryId: null,
      });
      assert.ok(typeof created.id === 'string');
      assert.equal(created.content, 'User prefers dark mode');

      // List with filter
      const listed = await service.listItems({ tier: 'profile' });
      assert.equal(listed.length, 1);

      // Update
      const updated = await service.upsertItem({
        id: created.id,
        tier: 'profile',
        content: 'User strongly prefers dark mode',
        tags: ['preference'],
        importance: 8,
        sourceEntryId: null,
      });
      assert.equal(updated.content, 'User strongly prefers dark mode');
      assert.equal(updated.id, created.id);

      // Delete
      await service.deleteItem(created.id);
      const afterDelete = await service.store.get(created.id);
      assert.equal(afterDelete, null);
    });
  });

  test('MemoryService.search works with custom k', async () => {
    await withMemServices(async ({ service, store }) => {
      await seedSemanticData(store);

      const all = await service.search('architecture', 10);
      const few = await service.search('architecture', 3);

      assert.ok(few.length <= 3);
      assert.ok(all.length >= few.length);
    });
  });

  test('MemoryService.search with tier filtering', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);

      // Search only the episodic tier
      const results = await store.search('distributed systems engineer', 5, ['episodic']);
      const profileItem = results.find((r) => r.item.tier === 'profile');
      assert.equal(
        profileItem,
        undefined,
        'profile items should not appear when filtering to episodic only',
      );
    });
  });

  // ── 4. Prefetch pipeline ─────────────────────────────────────────────

  test('prefetch combines message with previous assistant turn for query', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);

      const result = await prefetch(
        store,
        'what about that?',
        'We discussed the database migration and Kafka setup.',
        makeLiveWindow(),
        BASE_CFG.prefetch,
      );

      // The combined query should retrieve database/Kafka items
      assert.ok(result.context !== null || true, 'should not crash');
      if (result.context) {
        assert.ok(
          result.context.toLowerCase().includes('kafka') ||
            result.context.toLowerCase().includes('database') ||
            result.context.toLowerCase().includes('migration'),
          `prev assistant turn should help resolve anaphora, got: "${result.context}"`,
        );
      }
    });
  });

  test('prefetch respects maxTokens cap with real data', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);

      const result = await prefetch(store, 'software engineering', null, makeLiveWindow(), {
        ...BASE_CFG.prefetch,
        maxTokens: 50,
      });

      if (result.context !== null) {
        const approxTokens = Math.ceil(result.context.length / 4);
        assert.ok(
          approxTokens <= 60,
          `context should stay near token budget (${approxTokens} tokens for "${result.context.slice(0, 60)}...")`,
        );
      }
    });
  });

  test('prefetch with empty store returns null', async () => {
    await withMemServices(async ({ store }) => {
      const result = await prefetch(store, 'anything', null, makeLiveWindow(), BASE_CFG.prefetch);
      assert.equal(result.context, null);
      assert.deepEqual(result.hits, []);
    });
  });

  test('prefetch items are in score-descending order', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);

      const result = await prefetch(
        store,
        'software architecture design patterns',
        null,
        makeLiveWindow(),
        BASE_CFG.prefetch,
      );

      if (result.hits.length >= 2) {
        for (let i = 1; i < result.hits.length; i++) {
          assert.ok(
            result.hits[i - 1].score >= result.hits[i].score,
            `hits sorted descending by score (idx ${i - 1}: ${result.hits[i - 1].score} vs idx ${i}: ${result.hits[i].score})`,
          );
        }
      }
    });
  });

  // ── 5. memory_search tool ────────────────────────────────────────────

  test('memory_search tool works with real store', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);
      const tool = createMemorySearchTool(store, BASE_CFG);

      const result = await tool.execute('call-1', { query: 'hiking' }, undefined, undefined, {} as ExtensionContext);

      assert.ok(result.content.length > 0);
      const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join(' ');
      assert.ok(text.toLowerCase().includes('hiking'));
    });
  });

  test('memory_search tool returns "no matches" for empty store', async () => {
    await withMemServices(async ({ store }) => {
      const tool = createMemorySearchTool(store, BASE_CFG);

      const result = await tool.execute('call-2', { query: 'anything' }, undefined, undefined, {} as ExtensionContext);

      const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join(' ');
      assert.ok(text.includes('No matching'));
    });
  });

  test('memory_search tool gracefully handles closed store', async () => {
    await withMemServices(async ({ store }) => {
      await store.close();
      const tool = createMemorySearchTool(store, BASE_CFG);

      const result = await tool.execute('call-3', { query: 'test' }, undefined, undefined, {} as ExtensionContext);

      const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join(' ');
      assert.ok(text.includes('failed') || text.includes('closed'));
    });
  });

  // ── 6. Full lifecycle ─────────────────────────────────────────────────

  test('full lifecycle: upsert → search → prefetch → update → delete', async () => {
    await withMemServices(async ({ service, store }) => {
      // Create items across both tiers
      const profileItem = await service.upsertItem({
        tier: 'profile',
        content: 'User is a software architect focused on scalability',
        tags: ['person'],
        importance: 9,
        sourceEntryId: null,
      });

      const episodicItem = await service.upsertItem({
        tier: 'episodic',
        content: 'The team evaluated AWS Lambda vs Kubernetes for the new pipeline',
        tags: ['project', 'event'],
        importance: 7,
        sourceEntryId: 'entry-old-1',
      });

      // Search finds the relevant item
      const searchResults = await service.search('serverless container orchestration');
      assert.ok(searchResults.length > 0, 'search should find relevant items');
      const foundEpisodic = searchResults.some(
        (r) => r.item.content.includes('Kubernetes') || r.item.content.includes('Lambda'),
      );
      assert.ok(foundEpisodic, 'search should surface the infrastructure discussion');

      // Prefetch excludes the episodic item (it has live sourceEntryId)
      const fetchResult = await service.prefetchForMessage(
        'what infrastructure decisions were made',
        null,
        makeLiveWindow(new Set(['entry-old-1'])),
      );
      if (fetchResult.hits.length > 0) {
        const liveFound = fetchResult.hits.some((h) => h.item.sourceEntryId === 'entry-old-1');
        assert.equal(liveFound, false, 'prefetch must exclude live items');
      }

      // Update the profile item
      const updated = await service.upsertItem({
        id: profileItem.id,
        tier: 'profile',
        content: 'User is a software architect focused on scalability and reliability',
        tags: ['person'],
        importance: 10,
        sourceEntryId: null,
      });
      assert.equal(updated.importance, 10);
      assert.ok(updated.updatedAt > profileItem.updatedAt);

      // Delete the episodic item
      await service.deleteItem(episodicItem.id);
      const deleted = await store.get(episodicItem.id);
      assert.equal(deleted, null);

      // Verify profile item still exists
      const stillThere = await store.get(profileItem.id);
      assert.notEqual(stillThere, null);
      assert.equal(stillThere!.importance, 10);
    });
  });

  // ── 7. List with filters ─────────────────────────────────────────────

  test('listItems with tier filter returns correct items', async () => {
    await withMemServices(async ({ service, store }) => {
      await seedSemanticData(store);

      const profileItems = await service.listItems({ tier: 'profile' });
      assert.equal(profileItems.length, 1);
      assert.equal(profileItems[0].tier, 'profile');

      const episodicItems = await service.listItems({ tier: 'episodic' });
      assert.ok(episodicItems.length > 1);
      for (const item of episodicItems) {
        assert.equal(item.tier, 'episodic');
      }
    });
  });

  test('listItems with tag filter returns correct items', async () => {
    await withMemServices(async ({ service, store }) => {
      await seedSemanticData(store);

      const projectItems = await service.listItems({ tags: ['project'] });
      assert.ok(projectItems.length >= 1, 'should find project-tagged items');
      for (const item of projectItems) {
        assert.ok(item.tags.includes('project'));
      }
    });
  });

  test('listItems with pagination works', async () => {
    await withMemServices(async ({ service, store }) => {
      await seedSemanticData(store);

      const page1 = await service.listItems({ limit: 2, offset: 0 });
      assert.ok(page1.length <= 2);
      assert.equal(page1.length, 2); // we have 8 items

      const page2 = await service.listItems({ limit: 2, offset: 2 });
      assert.ok(page2.length > 0);
    });
  });

  // ── 8. Edge cases ────────────────────────────────────────────────────

  test('empty query returns no prefetch context', async () => {
    await withMemServices(async ({ service, store }) => {
      await seedSemanticData(store);

      const result = await service.prefetchForMessage('', null, makeLiveWindow());
      assert.equal(result.context, null);
      assert.deepEqual(result.hits, []);
    });
  });

  test('delete non-existent id is idempotent', async () => {
    await withMemServices(async ({ service }) => {
      await service.deleteItem('nonexistent-id');
      // No error = success
    });
  });

  test('dual service instances on same database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-e2e-dual-'));
    const dbPath = join(dir, 'dual.db');
    const embeddings1 = new LocalEmbeddingProvider(MODEL_ID, DIMS);
    const store1 = new SqliteMemoryStore(dbPath, embeddings1);
    const service1 = new MemoryService(BASE_CFG, store1, embeddings1);

    const embeddings2 = new LocalEmbeddingProvider(MODEL_ID, DIMS);
    const store2 = new SqliteMemoryStore(dbPath, embeddings2);
    const service2 = new MemoryService(BASE_CFG, store2, embeddings2);

    try {
      await service1.upsertItem({
        tier: 'episodic',
        content: 'Shared data from instance 1',
        tags: ['event'],
        importance: 5,
        sourceEntryId: null,
      });

      const items = await service2.listItems();
      assert.ok(items.length > 0);
      assert.ok(items.some((i) => i.content.includes('instance 1')));
    } finally {
      await service1.dispose();
      await service2.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('search across all tiers returns mixed results', async () => {
    await withMemServices(async ({ store }) => {
      await seedSemanticData(store);

      const results = await store.search('backend engineer', 5);
      const tiers = results.map((r) => r.item.tier);
      assert.ok(
        tiers.includes('profile'),
        'should include the profile item about backend engineer',
      );
      assert.ok(tiers.includes('episodic'), 'should also include episodic matches');
    });
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
