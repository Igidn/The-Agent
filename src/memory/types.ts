export type MemoryTier = "profile" | "episodic";
export type MemoryTag =
  | "preference"
  | "person"
  | "event"
  | "project"
  | "correction"
  | "summary";

export interface MemoryItem {
  id: string;
  tier: MemoryTier;
  content: string;
  tags: MemoryTag[];
  entities?: string[];
  importance: number;
  sourceEntryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScoredItem {
  item: MemoryItem;
  cosine: number;
  score: number;
}

export interface EmbeddingProvider {
  dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface MemoryStore {
  upsert(
    item: Omit<MemoryItem, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<MemoryItem>;
  get(id: string): Promise<MemoryItem | null>;
  list(opts?: {
    tier?: MemoryTier;
    tags?: MemoryTag[];
    limit?: number;
    offset?: number;
  }): Promise<MemoryItem[]>;
  delete(id: string): Promise<void>;
  search(text: string, k: number, tiers?: MemoryTier[]): Promise<ScoredItem[]>;
  close(): Promise<void>;
}

export interface ExtractedFact {
  content: string;
  tags: MemoryTag[];
  importance: number;
}

export interface ExtractionDecision {
  action: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  targetId?: string;
  content?: string;
}

export interface PrefetchResult {
  context: string | null;
  hits: ScoredItem[];
}
