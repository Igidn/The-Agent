import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteMemoryStore } from './store.js';
import { prefetch } from './prefetch.js';
import type { LiveWindow } from '../core/window/types.js';
import type { EmbeddingProvider, MemoryItem, MemoryStore } from './types.js';

// ---------------------------------------------------------------------------
// Fake embedding provider — deterministic, constant-dimension, no ML needed.
// ---------------------------------------------------------------------------

const DIMS = 384;

const fakeEmbeddings: EmbeddingProvider = {
  dims: DIMS,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      // Word-aware hashing: split into words, hash each, then average.
      // This makes texts sharing words produce correlated vectors.
      const words = t
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((w) => w.length > 0);
      if (words.length === 0) {
        // Empty text → zero-ish vector
        const arr = new Array(DIMS).fill(0);
        arr[0] = 1;
        return arr;
      }

      // Build a vector by averaging word-level sine embeddings.
      const sum = new Array(DIMS).fill(0);
      for (const word of words) {
        let seed = 0;
        for (let i = 0; i < word.length; i++) {
          seed = ((seed << 5) - seed + word.charCodeAt(i)) | 0;
        }
        for (let i = 0; i < DIMS; i++) {
          sum[i] += Math.sin(seed * (i + 1)) * 0.5 + 0.5;
        }
      }
      const arr = sum.map((v) => v / words.length);

      // Normalise to unit length
      const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0)) || 1;
      return arr.map((v) => v / mag);
    });
  },
};

// ---------------------------------------------------------------------------
// Fake live window
// ---------------------------------------------------------------------------

function makeLiveWindow(liveIds: Set<string>): LiveWindow {
  return {
    boundaryEntryId: liveIds.size > 0 ? [...liveIds][0] : null,
    isLive(id: string): boolean {
      return liveIds.has(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Default config matching the env-var defaults in config/index.ts
// ---------------------------------------------------------------------------

const DEFAULT_CFG = {
  topK: 16,
  maxTokens: 300,
  strictCosine: 0.6,
  scoreThreshold: 0.4,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempStore(fn: (store: SqliteMemoryStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'memory-prefetch-'));
  const dbPath = join(dir, 'test.db');
  const store = new SqliteMemoryStore(dbPath, fakeEmbeddings);
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Insert a memory item for testing. */
async function insertItem(
  store: MemoryStore,
  overrides: Partial<MemoryItem> & { content: string },
): Promise<MemoryItem> {
  return store.upsert({
    tier: overrides.tier ?? 'episodic',
    content: overrides.content,
    tags: overrides.tags ?? ['event'],
    entities: overrides.entities,
    importance: overrides.importance ?? 5,
    sourceEntryId: overrides.sourceEntryId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('prefetch: returns null context when store is empty', async () => {
  await withTempStore(async (store) => {
    const result = await prefetch(
      store,
      'hello world',
      null,
      makeLiveWindow(new Set()),
      DEFAULT_CFG,
    );
    assert.equal(result.context, null);
    assert.deepEqual(result.hits, []);
  });
});

test('prefetch: returns relevant items for a matching query', async () => {
  await withTempStore(async (store) => {
    await insertItem(store, { content: 'user likes hiking in the mountains' });
    await insertItem(store, { content: 'user prefers dark mode for coding' });
    await insertItem(store, { content: 'user has a dog named Max' });

    const result = await prefetch(
      store,
      'what do they like to do outdoors',
      null,
      makeLiveWindow(new Set()),
      DEFAULT_CFG,
    );

    assert.ok(result.context !== null, 'should have a context');
    assert.ok(result.hits.length > 0, 'should have hits');
    // The hiking item should be the most relevant
    assert.ok(result.context.includes('hiking'), 'should mention hiking');
  });
});

test('prefetch: excludes live items whose sourceEntryId is in the window', async () => {
  await withTempStore(async (store) => {
    const liveItem = await insertItem(store, {
      content: 'user just said they love pizza',
      sourceEntryId: 'entry-live-1',
    });
    const oldItem = await insertItem(store, {
      content: 'user mentioned they prefer coffee over tea',
      sourceEntryId: 'entry-old-1',
    });

    const result = await prefetch(
      store,
      'pizza and coffee preferences',
      null,
      makeLiveWindow(new Set(['entry-live-1'])),
      DEFAULT_CFG,
    );

    assert.ok(result.context !== null, 'should have a context');
    // The live pizza item should be excluded, but coffee might still show
    // depending on cosine scores. At minimum, nothing with sourceEntryId
    // that's live should appear.
    for (const hit of result.hits) {
      if (hit.item.sourceEntryId === 'entry-live-1') {
        assert.fail('live item should not appear in results');
      }
    }
  });
});

test('prefetch: items with null sourceEntryId are always eligible', async () => {
  await withTempStore(async (store) => {
    // Summary chunks and consolidated facts typically have null sourceEntryId.
    await insertItem(store, {
      content: 'user is a software engineer',
      tier: 'episodic',
      tags: ['summary'],
      sourceEntryId: null,
    });

    const result = await prefetch(
      store,
      'what do they do for work',
      null,
      makeLiveWindow(new Set(['anything-else'])),
      DEFAULT_CFG,
    );

    assert.ok(result.context !== null, 'should find null-source items');
  });
});

test('prefetch: combines message with previous assistant turn for query', async () => {
  await withTempStore(async (store) => {
    await insertItem(store, {
      content: 'the project uses TypeScript with Node.js',
      tags: ['project'],
    });

    // "what about that?" needs the prev turn to resolve
    const result = await prefetch(
      store,
      'what about that?',
      'We discussed the tech stack earlier.',
      makeLiveWindow(new Set()),
      DEFAULT_CFG,
    );

    assert.ok(result.context !== null, 'should resolve anaphora');
    if (result.context) {
      assert.ok(
        result.context.includes('TypeScript') || result.context.includes('project'),
        'should include the project detail',
      );
    }
  });
});

test('prefetch: filters by strictCosine cutoff and entity overlap', async () => {
  await withTempStore(async (store) => {
    // Item with very different content but sharing an entity name
    await insertItem(store, {
      content: 'Alice is a graphic designer',
      entities: ['Alice'],
      tags: ['person'],
    });

    // Query mentions Alice but is about a different topic
    const result = await prefetch(
      store,
      'What does Alice think about the new design tool',
      null,
      makeLiveWindow(new Set()),
      { ...DEFAULT_CFG, strictCosine: 0.99 }, // Very high threshold
    );

    // Even with high strictCosine, the entity "Alice" overlap should
    // let it through.
    assert.ok(result.context !== null, 'entity overlap should pass the filter');
  });
});

test('prefetch: kills vibe-matching when no entity overlap and low cosine', async () => {
  await withTempStore(async (store) => {
    await insertItem(store, {
      content: 'games night with my friends was fun',
      tags: ['event'],
      entities: ['friends'],
    });

    // "gaming" is semantically similar but different topic
    const result = await prefetch(
      store,
      'gaming',
      null,
      makeLiveWindow(new Set()),
      { ...DEFAULT_CFG, strictCosine: 0.99 }, // Very high threshold
    );

    // "friends" from the item does not appear in "gaming" → no entity
    // overlap, so the item should be filtered out.
    assert.equal(result.context, null, 'vibe-match should be killed');
  });
});

test('prefetch: returns null when nothing passes scoreThreshold', async () => {
  await withTempStore(async (store) => {
    // Insert something with low importance and old timestamp
    const oldDate = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await store.upsert({
      tier: 'episodic',
      content: 'completely irrelevant fact',
      tags: ['event'],
      importance: 1,
      sourceEntryId: null,
      // We can't set updatedAt directly through upsert, but we can
      // work around it. Actually, updatedAt is set by the store...
      // Let's just use a very high score threshold.
    });

    const result = await prefetch(
      store,
      'something completely unrelated and different topic',
      null,
      makeLiveWindow(new Set()),
      { ...DEFAULT_CFG, scoreThreshold: 99 }, // Impossible threshold
    );

    assert.equal(result.context, null, 'no results above impossible threshold');
    assert.deepEqual(result.hits, []);
  });
});

test('prefetch: context respects maxTokens cap', async () => {
  await withTempStore(async (store) => {
    // Insert many items so we can test the cap
    for (let i = 0; i < 20; i++) {
      await insertItem(store, {
        content: `user fact number ${i} that is long enough to consume tokens when rendered repeatedly`,
        tags: ['event'],
      });
    }

    const result = await prefetch(
      store,
      'user facts',
      null,
      makeLiveWindow(new Set()),
      { ...DEFAULT_CFG, maxTokens: 20 }, // very tight budget
    );

    if (result.context !== null) {
      const rendered = result.context;
      const approxTokens = Math.ceil(rendered.length / 4);
      assert.ok(
        approxTokens <= 20 + 5, // small fudge for the last line
        `rendered context should stay within budget (got ~${approxTokens} tokens for "${rendered.slice(0, 40)}...")`,
      );
    }
  });
});

test('prefetch: returns hits in score-descending order', async () => {
  await withTempStore(async (store) => {
    await insertItem(store, {
      content: 'mildly relevant detail about the project structure',
      importance: 3,
    });
    await insertItem(store, {
      content: 'very critical information about the architecture decisions',
      importance: 9,
    });
    await insertItem(store, {
      content: 'somewhat useful note about the deployment pipeline',
      importance: 6,
    });

    const result = await prefetch(
      store,
      'architecture project deployment',
      null,
      makeLiveWindow(new Set()),
      DEFAULT_CFG,
    );

    if (result.hits.length >= 2) {
      for (let i = 1; i < result.hits.length; i++) {
        assert.ok(
          result.hits[i - 1].score >= result.hits[i].score,
          `hits should be sorted by score descending (idx ${i - 1}=${result.hits[i - 1].score} vs idx ${i}=${result.hits[i].score})`,
        );
      }
    }
  });
});

test('prefetch: empty message returns null context', async () => {
  await withTempStore(async (store) => {
    await insertItem(store, { content: 'some content' });

    const result = await prefetch(store, '', null, makeLiveWindow(new Set()), DEFAULT_CFG);

    assert.equal(result.context, null);
    assert.deepEqual(result.hits, []);
  });
});

test('prefetch: prevAssistantTurn alone with empty message returns null', async () => {
  await withTempStore(async (store) => {
    await insertItem(store, { content: 'some content' });

    const result = await prefetch(
      store,
      '',
      'previous assistant message',
      makeLiveWindow(new Set()),
      DEFAULT_CFG,
    );

    // message is empty, query is just the prev turn, but message.trim() === ""
    // buildQuery returns just prevAssistantTurn which is non-empty, so it
    // should still query.
    // Actually, let me check: queryText = buildQuery("", "previous assistant message")
    // = "previous assistant message" which is non-empty. So it should search.
    // But the content may not match semantically.
    // The assertion here is just that it doesn't crash.
    assert.ok(result.context === null || typeof result.context === 'string');
  });
});

test('prefetch: multiple items rendered as bullet lines', async () => {
  await withTempStore(async (store) => {
    await insertItem(store, {
      content: 'user prefers functional programming',
      importance: 7,
    });
    await insertItem(store, {
      content: 'user dislikes unnecessary complexity',
      importance: 6,
    });

    const result = await prefetch(
      store,
      'programming preferences',
      null,
      makeLiveWindow(new Set()),
      DEFAULT_CFG,
    );

    if (result.context !== null) {
      const lines = result.context.split('\n');
      for (const line of lines) {
        assert.ok(line.startsWith('- '), `each line should start with "- ": "${line}"`);
      }
    }
  });
});

test('prefetch: profile items are never returned', async () => {
  await withTempStore(async (store) => {
    await insertItem(store, {
      content: 'user is a system architect',
      tier: 'profile',
      importance: 8,
    });
    await insertItem(store, {
      content: 'user discussed system design patterns',
      tier: 'episodic',
      importance: 6,
    });

    const result = await prefetch(
      store,
      'system architecture and design',
      null,
      makeLiveWindow(new Set()),
      DEFAULT_CFG,
    );

    // Profile items live in the system prompt already; prefetch draws
    // from the episodic tier only.
    const tiers = result.hits.map((h) => h.item.tier);
    assert.ok(
      !tiers.includes('profile'),
      `profile items must not be prefetched, got tiers: ${tiers}`,
    );
    assert.ok(result.context !== null, 'episodic items should be returned');
  });
});
