import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteMemoryStore } from './store.js';
import type { EmbeddingProvider, MemoryItem, MemoryTag, MemoryTier } from './types.js';

// ---------------------------------------------------------------------------
// Fake embedding provider — deterministic, constant-dimension, no ML needed.
// ---------------------------------------------------------------------------

const DIMS = 384;

const fakeEmbeddings: EmbeddingProvider = {
  dims: DIMS,
  async embed(texts: string[]): Promise<number[][]> {
    // Deterministic embedding: hash each text into a unit vector so similar
    // texts get similar vectors (crude but sufficient for store tests).
    return texts.map((t) => {
      let seed = 0;
      for (let i = 0; i < t.length; i++) {
        seed = ((seed << 5) - seed + t.charCodeAt(i)) | 0;
      }
      const arr = new Array(DIMS);
      for (let i = 0; i < DIMS; i++) {
        // Pseudo-hash each dimension so small changes in text shift the vector
        arr[i] = Math.sin(seed * (i + 1)) * 0.5 + 0.5;
      }
      // Normalise to unit length so cosine similarity is meaningful
      const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0)) || 1;
      return arr.map((v) => v / mag);
    });
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempStore(
  fn: (store: SqliteMemoryStore, dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'memory-store-'));
  const dbPath = join(dir, 'test.db');
  const store = new SqliteMemoryStore(dbPath, fakeEmbeddings);
  try {
    await fn(store, dbPath);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A minimal item payload for testing. */
function makeItem(
  overrides?: Partial<MemoryItem>,
): Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    tier: overrides?.tier ?? 'episodic',
    content: overrides?.content ?? 'some memory content',
    tags: overrides?.tags ?? ['event'],
    entities: overrides?.entities,
    importance: overrides?.importance ?? 0.5,
    sourceEntryId: overrides?.sourceEntryId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('SqliteMemoryStore: upsert creates a new item with generated id', async () => {
  await withTempStore(async (store) => {
    const item = await store.upsert(makeItem({ content: 'hello world' }));
    assert.ok(typeof item.id === 'string' && item.id.length > 0);
    assert.equal(item.content, 'hello world');
    assert.equal(item.tier, 'episodic');
    assert.deepEqual(item.tags, ['event']);
    assert.equal(item.importance, 0.5);
    assert.equal(item.sourceEntryId, null);
    assert.ok(typeof item.createdAt === 'string');
    assert.equal(item.updatedAt, item.createdAt);
  });
});

test('SqliteMemoryStore: upsert with existing id updates in place', async () => {
  await withTempStore(async (store) => {
    const original = await store.upsert(makeItem({ content: 'original' }));
    const updated = await store.upsert({
      ...makeItem({ content: 'updated version', importance: 0.9 }),
      id: original.id,
    });

    assert.equal(updated.id, original.id);
    assert.equal(updated.content, 'updated version');
    assert.equal(updated.importance, 0.9);
    assert.ok(new Date(updated.updatedAt) > new Date(original.updatedAt));
  });
});

test('SqliteMemoryStore: upsert throws on update for nonexistent id', async () => {
  await withTempStore(async (store) => {
    await assert.rejects(
      () =>
        store.upsert({
          ...makeItem(),
          id: 'nonexistent-uuid',
        }),
      /not found/,
    );
  });
});

test('SqliteMemoryStore: get returns the item or null', async () => {
  await withTempStore(async (store) => {
    const created = await store.upsert(makeItem({ content: 'gettable' }));
    const found = await store.get(created.id);
    assert.notEqual(found, null);
    assert.equal(found!.content, 'gettable');

    const missing = await store.get('no-such-id');
    assert.equal(missing, null);
  });
});

test('SqliteMemoryStore: list returns all items sorted by newest first', async () => {
  await withTempStore(async (store) => {
    await store.upsert(makeItem({ content: 'first' }));
    // Slight delay to ensure ordering
    await new Promise((r) => setTimeout(r, 5));
    await store.upsert(makeItem({ content: 'second' }));

    const all = await store.list();
    assert.equal(all.length, 2);
    // Most recent first
    assert.equal(all[0].content, 'second');
    assert.equal(all[1].content, 'first');
  });
});

test('SqliteMemoryStore: list with tier filter', async () => {
  await withTempStore(async (store) => {
    await store.upsert(makeItem({ content: 'ep event', tier: 'episodic' }));
    await store.upsert(makeItem({ content: 'profile info', tier: 'profile' }));

    const episodic = await store.list({ tier: 'episodic' });
    assert.equal(episodic.length, 1);
    assert.equal(episodic[0].tier, 'episodic');

    const profile = await store.list({ tier: 'profile' });
    assert.equal(profile.length, 1);
    assert.equal(profile[0].tier, 'profile');
  });
});

test('SqliteMemoryStore: list with tag filter', async () => {
  await withTempStore(async (store) => {
    await store.upsert(makeItem({ content: 'likes coffee', tags: ['preference'] }));
    await store.upsert(makeItem({ content: 'met alice', tags: ['person'] }));
    await store.upsert(makeItem({ content: 'project gamma', tags: ['project'] }));

    const withPrefs = await store.list({ tags: ['preference'] });
    assert.equal(withPrefs.length, 1);
    assert.equal(withPrefs[0].content, 'likes coffee');

    const withPerson = await store.list({ tags: ['person'] });
    assert.equal(withPerson.length, 1);

    // Multiple tags: OR logic
    const prefsOrPerson = await store.list({ tags: ['preference', 'person'] });
    assert.equal(prefsOrPerson.length, 2);
  });
});

test('SqliteMemoryStore: list with pagination', async () => {
  await withTempStore(async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.upsert(makeItem({ content: `item ${i}` }));
    }

    const page1 = await store.list({ limit: 2, offset: 0 });
    assert.equal(page1.length, 2);
    assert.equal(page1[0].content, 'item 4'); // newest first

    const page2 = await store.list({ limit: 2, offset: 2 });
    assert.equal(page2.length, 2);
    assert.equal(page2[0].content, 'item 2');
  });
});

test('SqliteMemoryStore: delete removes item and vector', async () => {
  await withTempStore(async (store) => {
    const item = await store.upsert(makeItem({ content: 'to-delete' }));
    assert.notEqual(await store.get(item.id), null);

    await store.delete(item.id);
    assert.equal(await store.get(item.id), null);
  });
});

test('SqliteMemoryStore: delete is idempotent', async () => {
  await withTempStore(async (store) => {
    await store.delete('never-existed');
    // No error = success
  });
});

test('SqliteMemoryStore: search returns ScoredItem[] ordered by similarity', async () => {
  await withTempStore(async (store) => {
    // Insert items with different content
    await store.upsert(makeItem({ content: 'cats are furry animals' }));
    await store.upsert(makeItem({ content: 'dogs are loyal pets' }));
    await store.upsert(makeItem({ content: 'quantum physics is fascinating' }));

    // Search returns results sorted by cosine (higher = more similar)
    const results = await store.search('feline cats', 5);
    assert.ok(results.length > 0);
    assert.ok(results[0].cosine >= 0);
    assert.ok(results[0].score >= 0);
    // Verify descending cosine order
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].cosine >= results[i].cosine);
    }
  });
});

test('SqliteMemoryStore: search with tier filter', async () => {
  await withTempStore(async (store) => {
    await store.upsert(
      makeItem({
        content: 'user likes hiking',
        tags: ['preference'],
        tier: 'episodic',
      }),
    );
    await store.upsert(
      makeItem({
        content: 'user is an engineer',
        tags: ['person'],
        tier: 'profile',
      }),
    );

    const episodicResults = await store.search('engineer', 5, ['episodic']);
    // The profile item ("user is an engineer") should be filtered out
    for (const r of episodicResults) {
      assert.equal(r.item.tier, 'episodic');
    }

    const profileResults = await store.search('hiking', 5, ['profile']);
    for (const r of profileResults) {
      assert.equal(r.item.tier, 'profile');
    }
  });
});

test('SqliteMemoryStore: search with k=0 returns empty', async () => {
  await withTempStore(async (store) => {
    await store.upsert(makeItem({ content: 'something' }));
    const results = await store.search('something', 0);
    assert.deepEqual(results, []);
  });
});

test('SqliteMemoryStore: stores and retrieves entities', async () => {
  await withTempStore(async (store) => {
    const item = await store.upsert(
      makeItem({
        content: 'met Bob at the cafe',
        entities: ['Bob', 'cafe'],
      }),
    );
    assert.deepEqual(item.entities, ['Bob', 'cafe']);

    const fetched = await store.get(item.id);
    assert.deepEqual(fetched!.entities, ['Bob', 'cafe']);
  });
});

test('SqliteMemoryStore: stores and retrieves sourceEntryId', async () => {
  await withTempStore(async (store) => {
    const item = await store.upsert(
      makeItem({
        content: 'from a conversation',
        sourceEntryId: 'entry-42',
      }),
    );
    assert.equal(item.sourceEntryId, 'entry-42');

    const fetched = await store.get(item.id);
    assert.equal(fetched!.sourceEntryId, 'entry-42');

    // null sourceEntryId is also fine
    const noSource = await store.upsert(makeItem({ content: 'no source' }));
    assert.equal(noSource.sourceEntryId, null);
  });
});

test('SqliteMemoryStore: close is idempotent and does not error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-close-'));
  const dbPath = join(dir, 'test.db');
  const store = new SqliteMemoryStore(dbPath, fakeEmbeddings);
  await store.close();
  // Second close should not throw
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('SqliteMemoryStore: does not share state between instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-isolated-'));
  const dbPath = join(dir, 'test.db');
  const storeA = new SqliteMemoryStore(dbPath, fakeEmbeddings);
  const storeB = new SqliteMemoryStore(dbPath, fakeEmbeddings);

  try {
    await storeA.upsert(makeItem({ content: 'from A' }));
    const itemsB = await storeB.list();
    assert.equal(itemsB.length, 1);
    assert.equal(itemsB[0].content, 'from A');
  } finally {
    await storeA.close();
    await storeB.close();
    await rm(dir, { recursive: true, force: true });
  }
});
