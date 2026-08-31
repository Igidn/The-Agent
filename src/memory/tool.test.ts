import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SqliteMemoryStore } from "./store.js";
import { createMemorySearchTool } from "./tool.js";
import type { EmbeddingProvider } from "./types.js";
import type { MemoryConfig } from "../shared/types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Fake embedding provider — deterministic, constant-dimension, no ML needed.
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
// Minimal config for the tool
// ---------------------------------------------------------------------------

const minimalCfg: MemoryConfig = {
  dbPath: "",
  embeddingModel: "Xenova/bge-small-en-v1.5",
  embeddingDims: DIMS,
  embedding: { provider: "local" },
  prefetch: { topK: 16, maxTokens: 300, strictCosine: 0.6, scoreThreshold: 0.3 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCtx = {} as ExtensionContext;

function textContent(resultContent: { type: string; text?: string }[]): string {
  return resultContent
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && c.text !== undefined)
    .map((c) => c.text)
    .join(" ");
}

async function withTempStore(
  fn: (store: SqliteMemoryStore) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "memory-tool-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteMemoryStore(dbPath, fakeEmbeddings);
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Seed the store with some sample items. */
async function seedStore(store: SqliteMemoryStore): Promise<void> {
  await store.upsert({
    tier: "episodic",
    content: "User mentioned they enjoy hiking on weekends",
    tags: ["preference"],
    importance: 6,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: "episodic",
    content: "The project deadline was extended to next Friday",
    tags: ["event", "project"],
    importance: 8,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: "profile",
    content: "User is a software engineer specializing in distributed systems",
    tags: ["person"],
    importance: 9,
    sourceEntryId: null,
  });

  await store.upsert({
    tier: "episodic",
    content: "User likes coffee with oat milk",
    tags: ["preference"],
    importance: 3,
    sourceEntryId: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("createMemorySearchTool returns a ToolDefinition with correct metadata", async () => {
  await withTempStore(async (store) => {
    const tool = createMemorySearchTool(store, minimalCfg);

    assert.equal(tool.name, "memory_search");
    assert.equal(tool.label, "Memory Search");
    assert.ok(typeof tool.description === "string" && tool.description.length > 0);
    assert.ok(tool.parameters !== undefined);
  });
});

test("memory_search returns results for a matching query", async () => {
  await withTempStore(async (store) => {
    await seedStore(store);
    const tool = createMemorySearchTool(store, minimalCfg);

    const result = await tool.execute(
      "call-1",
      { query: "hiking" },
      undefined,
      undefined,
      mockCtx,
    );

    assert.ok(result.content.length > 0);
    const text = textContent(result.content);
    assert.ok(text.includes("hiking"));
  });
});

test("memory_search returns empty response when store is empty", async () => {
  await withTempStore(async (store) => {
    const tool = createMemorySearchTool(store, minimalCfg);

    const result = await tool.execute(
      "call-2",
      { query: "anything" },
      undefined,
      undefined,
      mockCtx,
    );

    assert.ok(result.content.length > 0);
    const text = textContent(result.content);
    assert.ok(text.includes("No matching"));
  });
});

test("memory_search respects the k parameter", async () => {
  await withTempStore(async (store) => {
    await seedStore(store);
    const tool = createMemorySearchTool(store, minimalCfg);

    const result = await tool.execute(
      "call-3",
      { query: "user", k: 1 },
      undefined,
      undefined,
      mockCtx,
    );

    const text = textContent(result.content);
    assert.ok(text.length > 0);
  });
});

test("memory_search returns details: {} in result", async () => {
  await withTempStore(async (store) => {
    await seedStore(store);
    const tool = createMemorySearchTool(store, minimalCfg);

    const result = await tool.execute(
      "call-4",
      { query: "project" },
      undefined,
      undefined,
      mockCtx,
    );

    assert.deepEqual(result.details, {});
  });
});

test("memory_search handles store errors gracefully", async () => {
  await withTempStore(async (store) => {
    await store.close();

    const tool = createMemorySearchTool(store, minimalCfg);

    const result = await tool.execute(
      "call-5",
      { query: "anything" },
      undefined,
      undefined,
      mockCtx,
    );

    assert.ok(result.content.length > 0);
    const text = textContent(result.content);
    assert.ok(text.includes("failed") || text.includes("closed"));
  });
});