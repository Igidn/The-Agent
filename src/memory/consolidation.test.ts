import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Api,
  Message,
  AssistantMessage,
  Model,
  Models,
  Usage,
  TextContent,
} from '@earendil-works/pi-ai';

import type { EmbeddingProvider, MemoryItem, MemoryStore, MemoryTag } from './types.js';
import { SqliteMemoryStore } from './store.js';
import { consolidateProfile, renderProfileSection } from './consolidation.js';

// ---------------------------------------------------------------------------
// Fake embedding provider — deterministic, no ML needed.
// ---------------------------------------------------------------------------

const DIMS = 384;

const fakeEmbeddings: EmbeddingProvider = {
  dims: DIMS,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      let seed = 0;
      for (let i = 0; i < t.length; i++) {
        seed = ((seed << 5) - seed + t.charCodeAt(i)) | 0;
      }
      const arr = new Array(DIMS);
      for (let i = 0; i < DIMS; i++) {
        arr[i] = Math.sin(seed * (i + 1)) * 0.5 + 0.5;
      }
      const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0)) || 1;
      return arr.map((v) => v / mag);
    });
  },
};

// ---------------------------------------------------------------------------
// Fake Models
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempStore(fn: (store: SqliteMemoryStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'consolidation-'));
  const dbPath = join(dir, 'test.db');
  const store = new SqliteMemoryStore(dbPath, fakeEmbeddings);
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function makeProfileItem(content: string, overrides?: Partial<MemoryItem>) {
  return {
    tier: 'profile' as const,
    content,
    tags: overrides?.tags ?? (['preference'] as MemoryTag[]),
    importance: overrides?.importance ?? 5,
    sourceEntryId: null,
  };
}

function makeEpisodicItem(content: string, overrides?: Partial<MemoryItem>) {
  return {
    tier: 'episodic' as const,
    content,
    tags: overrides?.tags ?? (['event'] as MemoryTag[]),
    importance: overrides?.importance ?? 3,
    sourceEntryId: overrides?.sourceEntryId ?? 'entry-1',
  };
}

// ---------------------------------------------------------------------------
// consolidateProfile
// ---------------------------------------------------------------------------

test('consolidateProfile: replaces old profile with LLM-consolidated items', async () => {
  await withTempStore(async (store) => {
    // Seed some existing profile items.
    await store.upsert(makeProfileItem('User likes coffee'));
    await store.upsert(makeProfileItem('User works remotely'));

    // Seed some episodic facts.
    await store.upsert(
      makeEpisodicItem('User mentioned they prefer dark roast', {
        tags: ['preference'],
      }),
    );
    await store.upsert(
      makeEpisodicItem('User started a new project called Omega', {
        tags: ['project'],
      }),
    );

    // LLM returns consolidated profile statements as JSON.
    const canned = JSON.stringify([
      { content: 'User prefers dark roast coffee', tags: ['preference'], importance: 6 },
      { content: 'User works remotely from home', tags: ['preference'], importance: 5 },
      { content: 'User is working on project Omega', tags: ['project'], importance: 7 },
    ]);

    const newItems = await consolidateProfile(store, fakeModel(), fakeModels(canned));

    // Old profile items should be gone.
    const oldFirst = await store.get(
      (await store.list({ tier: 'profile' })).find((i) => i.content === 'User likes coffee')?.id ??
        '',
    );
    assert.equal(oldFirst, null);

    // New items should be in the store.
    assert.equal(newItems.length, 3);
    assert.ok(newItems.some((i) => i.content.includes('dark roast')));
    assert.ok(newItems.some((i) => i.content.includes('project Omega')));

    // All should be profile tier.
    for (const item of newItems) {
      assert.equal(item.tier, 'profile');
    }
  });
});

test('consolidateProfile: preserves existing profile when LLM returns empty', async () => {
  await withTempStore(async (store) => {
    const orig = await store.upsert(makeProfileItem('User likes coffee', { importance: 5 }));

    // LLM returns empty array.
    const newItems = await consolidateProfile(store, fakeModel(), fakeModels('[]'));

    // Existing item should remain unchanged.
    assert.equal(newItems.length, 1);
    assert.equal(newItems[0].content, orig.content);
    assert.equal(newItems[0].id, orig.id);
  });
});

test('consolidateProfile: preserves existing profile when LLM returns invalid JSON', async () => {
  await withTempStore(async (store) => {
    const orig = await store.upsert(makeProfileItem('User likes coffee', { importance: 5 }));

    // LLM returns something that is not valid JSON.
    const newItems = await consolidateProfile(
      store,
      fakeModel(),
      fakeModels('I do not have enough information to create a profile.'),
    );

    assert.equal(newItems.length, 1);
    assert.equal(newItems[0].id, orig.id);
  });
});

test('consolidateProfile: works with no existing profile items', async () => {
  await withTempStore(async (store) => {
    // Only episodic facts, no profile items yet.
    await store.upsert(
      makeEpisodicItem('User mentioned they love hiking', {
        tags: ['preference'],
      }),
    );

    const canned = JSON.stringify([
      { content: 'User loves hiking', tags: ['preference'], importance: 5 },
    ]);

    const newItems = await consolidateProfile(store, fakeModel(), fakeModels(canned));

    assert.equal(newItems.length, 1);
    assert.equal(newItems[0].content, 'User loves hiking');
  });
});

test('consolidateProfile: works with no episodic facts either', async () => {
  await withTempStore(async (store) => {
    // Nothing in the store at all.
    const canned = JSON.stringify([
      { content: 'Nothing known yet', tags: ['summary'], importance: 1 },
    ]);

    const newItems = await consolidateProfile(store, fakeModel(), fakeModels(canned));

    assert.equal(newItems.length, 1);
    assert.equal(newItems[0].content, 'Nothing known yet');
  });
});

test('consolidateProfile: throws on provider failure', async () => {
  await withTempStore(async (store) => {
    await assert.rejects(
      () => consolidateProfile(store, fakeModel(), failingModels()),
      /provider call failed/,
    );
  });
});

test('consolidateProfile: throws on provider error stop reason', async () => {
  await withTempStore(async (store) => {
    const errorModels: Models = {
      async complete() {
        return {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: '' }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'error' as const,
          errorMessage: 'model crashed',
          api: 'openai-completions' as const,
          provider: 'openai' as const,
          model: 'gpt-4o-mini' as const,
          timestamp: Date.now(),
        };
      },
    } as unknown as Models;

    await assert.rejects(
      () => consolidateProfile(store, fakeModel(), errorModels),
      /provider returned error/,
    );
  });
});

test('consolidateProfile: filters out non-profile tags from LLM output', async () => {
  await withTempStore(async (store) => {
    // LLM includes an item with an invalid tag.
    const canned = JSON.stringify([
      { content: 'Valid preference', tags: ['preference'], importance: 5 },
      { content: 'Invalid garbage', tags: ['invalid_tag' as MemoryTag], importance: 3 },
    ]);

    const newItems = await consolidateProfile(store, fakeModel(), fakeModels(canned));

    // Only the valid item should survive.
    assert.equal(newItems.length, 1);
    assert.equal(newItems[0].content, 'Valid preference');
  });
});

test('consolidateProfile: filters out items with out-of-range importance', async () => {
  await withTempStore(async (store) => {
    const canned = JSON.stringify([
      { content: 'Good item', tags: ['preference'], importance: 7 },
      { content: 'Bad importance -1', tags: ['preference'], importance: -1 },
      { content: 'Bad importance 11', tags: ['preference'], importance: 11 },
    ]);

    const newItems = await consolidateProfile(store, fakeModel(), fakeModels(canned));

    assert.equal(newItems.length, 1);
    assert.equal(newItems[0].content, 'Good item');
  });
});

test('consolidateProfile: handles many items without error', async () => {
  await withTempStore(async (store) => {
    // Insert 50 profile items and 100 episodic facts.
    for (let i = 0; i < 50; i++) {
      await store.upsert(makeProfileItem(`Profile item ${i}`, { importance: 3 }));
    }
    for (let i = 0; i < 100; i++) {
      await store.upsert(
        makeEpisodicItem(`Episodic fact ${i}`, {
          tags: ['event'],
          importance: 2,
        }),
      );
    }

    // LLM returns a consolidated set.
    const consolidated = Array.from({ length: 20 }, (_, i) => ({
      content: `Consolidated item ${i}`,
      tags: ['preference'] as MemoryTag[],
      importance: 5,
    }));

    const newItems = await consolidateProfile(
      store,
      fakeModel(),
      fakeModels(JSON.stringify(consolidated)),
    );

    assert.equal(newItems.length, 20);
  });
});

test('consolidateProfile: sourceEntryId is null on profile items', async () => {
  await withTempStore(async (store) => {
    const canned = JSON.stringify([
      { content: 'New profile fact', tags: ['preference'], importance: 5 },
    ]);

    const newItems = await consolidateProfile(store, fakeModel(), fakeModels(canned));

    for (const item of newItems) {
      assert.equal(item.sourceEntryId, null);
    }
  });
});

// ---------------------------------------------------------------------------
// renderProfileSection
// ---------------------------------------------------------------------------

test('renderProfileSection: returns empty string for empty list', () => {
  assert.equal(renderProfileSection([]), '');
});

test('renderProfileSection: renders single item as bullet point', () => {
  const items: MemoryItem[] = [
    {
      id: '1',
      tier: 'profile',
      content: 'User likes coffee',
      tags: ['preference'],
      importance: 5,
      sourceEntryId: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ];

  const result = renderProfileSection(items);
  assert.ok(result.includes('User likes coffee'));
  assert.ok(result.includes('- '));
  assert.ok(result.includes('=== User Profile ==='));
});

test('renderProfileSection: renders multiple items in order', () => {
  const items: MemoryItem[] = [
    {
      id: '1',
      tier: 'profile',
      content: 'First fact',
      tags: ['preference'],
      importance: 5,
      sourceEntryId: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
    {
      id: '2',
      tier: 'profile',
      content: 'Second fact',
      tags: ['person'],
      importance: 7,
      sourceEntryId: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ];

  const result = renderProfileSection(items);
  const lines = result.split('\n');
  assert.ok(lines[0].includes('=== User Profile ==='));
  assert.ok(lines[1].includes('First fact'));
  assert.ok(lines[2].includes('Second fact'));
});

test('renderProfileSection: items appear in the order they are passed', () => {
  const items: MemoryItem[] = [
    {
      id: 'a',
      tier: 'profile',
      content: 'Alpha',
      tags: ['preference'],
      importance: 3,
      sourceEntryId: null,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'b',
      tier: 'profile',
      content: 'Beta',
      tags: ['preference'],
      importance: 8,
      sourceEntryId: null,
      createdAt: '',
      updatedAt: '',
    },
  ];

  const result = renderProfileSection(items);
  const alphaIdx = result.indexOf('Alpha');
  const betaIdx = result.indexOf('Beta');
  assert.ok(alphaIdx >= 0);
  assert.ok(betaIdx >= 0);
  assert.ok(alphaIdx < betaIdx, 'items must retain order');
});
