import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import {
  LocalEmbeddingProvider,
  SidecarEmbeddingProvider,
  createEmbeddingProvider,
} from "./embeddings.js";
import type { MemoryConfig } from "../shared/types.js";

// ---------------------------------------------------------------------------
// LocalEmbeddingProvider
// ---------------------------------------------------------------------------

describe("LocalEmbeddingProvider", () => {
  test("dims property matches constructor argument", () => {
    const p = new LocalEmbeddingProvider("Xenova/bge-small-en-v1.5", 384);
    assert.equal(p.dims, 384);
  });

  test("embed returns correct shape after warmup", async () => {
    const p = new LocalEmbeddingProvider("Xenova/bge-small-en-v1.5", 384);
    const vectors = await p.embed(["hello world"]);
    assert.ok(Array.isArray(vectors));
    assert.equal(vectors.length, 1);
    assert.equal(vectors[0]!.length, 384);
    // All values are finite numbers
    for (const v of vectors[0]!) {
      assert.equal(typeof v, "number");
      assert.ok(Number.isFinite(v), `expected finite number, got ${v}`);
    }
  });

  test("embed handles multiple texts", async () => {
    const p = new LocalEmbeddingProvider("Xenova/bge-small-en-v1.5", 384);
    const vectors = await p.embed(["hello", "world", "foo bar baz"]);
    assert.equal(vectors.length, 3);
    assert.equal(vectors[0]!.length, 384);
    assert.equal(vectors[1]!.length, 384);
    assert.equal(vectors[2]!.length, 384);
    // Vectors for different texts should differ
    const a = vectors[0]!.slice(0, 3);
    const b = vectors[1]!.slice(0, 3);
    assert.notDeepEqual(a, b);
  });

  test("auto-warmup on first embed", async () => {
    // Warmup was not called explicitly, but embed should work
    const p = new LocalEmbeddingProvider("Xenova/bge-small-en-v1.5", 384);
    const vectors = await p.embed(["test"]);
    assert.equal(vectors.length, 1);
    assert.equal(vectors[0]!.length, 384);
  });
});

// ---------------------------------------------------------------------------
// SidecarEmbeddingProvider
// ---------------------------------------------------------------------------

describe("SidecarEmbeddingProvider", () => {
  /** Spin up a tiny embed server for one test. */
  async function withServer(
    fn: (url: string, server: Server) => Promise<void>,
  ): Promise<void> {
    const server = createServer(async (req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/embed")) {
        res.writeHead(405);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const { texts } = JSON.parse(Buffer.concat(chunks).toString()) as {
        texts: string[];
      };

      // Return dummy 384-dim vectors
      const embeddings = texts.map((_, i) =>
        Array.from({ length: 384 }, (__, j) => (i + 1) * (j + 1) * 1e-4),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings }));
    });

    const addr = new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address()!;
        resolve(`http://127.0.0.1:${(a as import("net").AddressInfo).port}`);
      });
    });

    try {
      await fn(await addr, server);
    } finally {
      server.close();
    }
  }

  test("dims property matches constructor argument", () => {
    const p = new SidecarEmbeddingProvider("http://localhost:9999", 384);
    assert.equal(p.dims, 384);
  });

  test("embed returns parsed response from sidecar", async () => {
    await withServer(async (url) => {
      const p = new SidecarEmbeddingProvider(url, 384);
      const vectors = await p.embed(["foo", "bar"]);

      assert.equal(vectors.length, 2);
      assert.equal(vectors[0]!.length, 384);
      assert.equal(vectors[1]!.length, 384);
      // Vectors differ per our dummy server
      assert.notDeepEqual(
        vectors[0]!.slice(0, 5),
        vectors[1]!.slice(0, 5),
      );
    });
  });

  test("embed throws on non-200 response", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("oops");
    });
    const addr = new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address()!;
        resolve(`http://127.0.0.1:${(a as import("net").AddressInfo).port}`);
      });
    });

    try {
      const p = new SidecarEmbeddingProvider(await addr, 384);
      await assert.rejects(
        () => p.embed(["fail"]),
        /Sidecar embed request failed/,
      );
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("createEmbeddingProvider", () => {
  const baseCfg: MemoryConfig = {
    dbPath: "./data/memory.db",
    embeddingModel: "Xenova/bge-small-en-v1.5",
    embeddingDims: 384,
    embedding: { provider: "local" },
    prefetch: {
      topK: 16,
      maxTokens: 300,
      strictCosine: 0.7,
      scoreThreshold: 0.5,
    },
  };

  test("returns LocalEmbeddingProvider when provider is 'local'", () => {
    const p = createEmbeddingProvider(baseCfg);
    assert.ok(p instanceof LocalEmbeddingProvider);
    assert.equal(p.dims, 384);
  });

  test("returns SidecarEmbeddingProvider when provider is 'sidecar'", () => {
    const p = createEmbeddingProvider({
      ...baseCfg,
      embedding: { provider: "sidecar", sidecarUrl: "http://localhost:8081" },
    });
    assert.ok(p instanceof SidecarEmbeddingProvider);
    assert.equal(p.dims, 384);
  });

  test("throws when sidecar provider is selected without sidecarUrl", () => {
    assert.throws(
      () =>
        createEmbeddingProvider({
          ...baseCfg,
          embedding: { provider: "sidecar" },
        }),
      /sidecarUrl is required/,
    );
  });
});