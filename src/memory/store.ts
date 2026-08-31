import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Statement } from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import type {
  EmbeddingProvider,
  MemoryItem,
  MemoryStore,
  MemoryTag,
  MemoryTier,
  ScoredItem,
} from "./types.js";

/**
 * SQLite-backed memory store with vector search via sqlite-vec.
 *
 * Stores items in an `items` table (metadata + content) and a `vec_items`
 * virtual table (embeddings). The two are linked by integer rowid.
 */
export class SqliteMemoryStore implements MemoryStore {
  private db: Database.Database;
  private _dims: number;

  private stmtGet: Statement;
  private stmtInsert: Statement;
  private stmtUpdate: Statement;
  private stmtDelete: Statement;
  private stmtDeleteVec: Statement;

  constructor(
    dbPath: string,
    private embeddings: EmbeddingProvider,
  ) {
    this._dims = embeddings.dims;
    // The audit sink creates its parent dir on first write; match that so
    // the default ./data/memory.db works on a fresh checkout.
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { safeIntegers: true } as any);
    loadVec(this.db);
    this.initSchema();

    // --- prepared statements ---
    this.stmtGet = this.db.prepare(
      "SELECT * FROM items WHERE uuid = ?",
    );

    this.stmtInsert = this.db.prepare(`
      INSERT INTO items (uuid, tier, content, tags, entities, importance, sourceEntryId, createdAt, updatedAt)
      VALUES (@uuid, @tier, @content, @tags, @entities, @importance, @sourceEntryId, @createdAt, @updatedAt)
    `);

    this.stmtUpdate = this.db.prepare(`
      UPDATE items
      SET tier = @tier, content = @content, tags = @tags, entities = @entities,
          importance = @importance, sourceEntryId = @sourceEntryId, updatedAt = @updatedAt
      WHERE uuid = @uuid
    `);

    this.stmtDelete = this.db.prepare("DELETE FROM items WHERE uuid = ?");

    this.stmtDeleteVec = this.db.prepare(
      "DELETE FROM vec_items WHERE rowid = ?",
    );
  }

  // ---- schema ----

  private initSchema(): void {
    const dims = this._dims;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid     TEXT    NOT NULL UNIQUE,
        tier     TEXT    NOT NULL CHECK(tier IN ('profile', 'episodic')),
        content  TEXT    NOT NULL,
        tags     TEXT    NOT NULL DEFAULT '[]',
        entities TEXT,
        importance REAL  NOT NULL DEFAULT 0,
        sourceEntryId TEXT,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_items_tier       ON items(tier);
      CREATE INDEX IF NOT EXISTS idx_items_uuid       ON items(uuid);
      CREATE INDEX IF NOT EXISTS idx_items_source_entry ON items(sourceEntryId);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
        embedding float[${dims}] distance_metric=cosine
      );
    `);
  }

  // ---- helpers ----

  /** Serialise tags array to a JSON string for storage. */
  private tagsToJson(tags: MemoryTag[]): string {
    return JSON.stringify(tags);
  }

  /** Parse stored JSON string back to a tags array. */
  private jsonToTags(raw: string): MemoryTag[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Build a MemoryItem from a query row. */
  private rowToItem(row: {
    uuid: string;
    tier: string;
    content: string;
    tags: string;
    entities: string | null;
    importance: number;
    sourceEntryId: string | null;
    createdAt: string;
    updatedAt: string;
  }): MemoryItem {
    return {
      id: row.uuid,
      tier: row.tier as MemoryTier,
      content: row.content,
      tags: this.jsonToTags(row.tags),
      entities: row.entities ? JSON.parse(row.entities) : undefined,
      importance: row.importance,
      sourceEntryId: row.sourceEntryId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ---- MemoryStore implementation ----

  async upsert(
    item: Omit<MemoryItem, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<MemoryItem> {
    const now = new Date().toISOString();

    if (item.id) {
      // Update existing item
      const existing = this.stmtGet.get(item.id) as Record<string, unknown> | undefined;
      if (!existing) {
        throw new Error(`Cannot update: item "${item.id}" not found`);
      }

      const params = {
        uuid: item.id,
        tier: item.tier,
        content: item.content,
        tags: this.tagsToJson(item.tags),
        entities: item.entities ? JSON.stringify(item.entities) : null,
        importance: item.importance,
        sourceEntryId: item.sourceEntryId ?? null,
        updatedAt: now,
      };
      this.stmtUpdate.run(params);

      // Recompute and update embedding
      const rowid = Number((existing as { id: number }).id);
      await this.updateEmbedding(rowid, item.content);

      return this.get(item.id) as Promise<MemoryItem>;
    }

    // Insert new item
    const uuid = randomUUID();
    const createdAt = now;

    const params = {
      uuid,
      tier: item.tier,
      content: item.content,
      tags: this.tagsToJson(item.tags),
      entities: item.entities ? JSON.stringify(item.entities) : null,
      importance: item.importance,
      sourceEntryId: item.sourceEntryId ?? null,
      createdAt,
      updatedAt: createdAt,
    };

    const result = this.stmtInsert.run(params);
    const rowid = Number(result.lastInsertRowid);

    // Compute and store embedding
    await this.updateEmbedding(rowid, item.content);

    return this.get(uuid) as Promise<MemoryItem>;
  }

  async get(id: string): Promise<MemoryItem | null> {
    const row = this.stmtGet.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToItem(row as any);
  }

  async list(
    opts?: {
      tier?: MemoryTier;
      tags?: MemoryTag[];
      limit?: number;
      offset?: number;
    },
  ): Promise<MemoryItem[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit, offset };

    if (opts?.tier) {
      conditions.push("tier = @tier");
      params.tier = opts.tier;
    }

    if (opts?.tags && opts.tags.length > 0) {
      // Build a JSON array check: the stored tags JSON must contain at least
      // one of the requested tags.  Uses json_each to unpack and match.
      const placeholders = opts.tags.map((_, i) => `@tag${i}`);
      conditions.push(
        `EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN (${placeholders.join(",")}))`,
      );
      opts.tags.forEach((tag, i) => {
        params[`tag${i}`] = tag;
      });
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM items ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all(params) as Record<string, unknown>[];

    return rows.map((r) => this.rowToItem(r as any));
  }

  async delete(id: string): Promise<void> {
    const existing = this.stmtGet.get(id) as Record<string, unknown> | undefined;
    if (!existing) return;

    const rowid = Number((existing as { id: number }).id);
    // Delete vector first (foreign-key-like constraint)
    this.stmtDeleteVec.run(BigInt(rowid));
    this.stmtDelete.run(id);
  }

  async search(
    text: string,
    k: number,
    tiers?: MemoryTier[],
  ): Promise<ScoredItem[]> {
    if (k < 1) return [];

    // 1. Embed the query
    const [queryVec] = await this.embeddings.embed([text]);

    // 2. Build the search query
    //    The vec0 virtual table's distance column returns cosine distance
    //    (0 = identical, 1 = orthogonal, 2 = opposite).
    //    Convert to cosine similarity: sim = 1 - distance.
    const tierFilter: string[] = [];
    const params: Record<string, unknown> = {
      query: new Float32Array(queryVec),
      k,
    };
    if (tiers && tiers.length > 0) {
      tiers.forEach((t, i) => {
        tierFilter.push(`@tier${i}`);
        params[`tier${i}`] = t;
      });
    }
    const tierSql = tierFilter.length > 0 ? `AND i.tier IN (${tierFilter.join(",")})` : "";

    const sql = `
      SELECT v.rowid, v.distance, i.uuid, i.tier, i.content, i.tags, i.entities,
             i.importance, i.sourceEntryId, i.createdAt, i.updatedAt
      FROM vec_items v
      JOIN items i ON i.id = v.rowid
      WHERE v.embedding MATCH @query
        ${tierSql}
        AND k = @k
      ORDER BY v.distance
    `;

    const rows = this.db.prepare(sql).all(params) as Record<string, unknown>[];

    return rows.map((r) => {
      const cosineDist = Number(r.distance);
      const cosine = 1 - cosineDist;
      const item = this.rowToItem(r as any);
      return {
        item,
        cosine,
        // Raw score defaults to cosine similarity; prefetch will re-score.
        score: cosine,
      };
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ---- internal helpers ----

  private async updateEmbedding(rowid: number, content: string): Promise<void> {
    const [vec] = await this.embeddings.embed([content]);
    this.stmtDeleteVec.run(BigInt(rowid));
    this.db
      .prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)")
      .run(BigInt(rowid), new Float32Array(vec));
  }
}