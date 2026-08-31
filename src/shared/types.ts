export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Auto-compaction policy in the design's absolute token counts.
 *
 * The design's open question ("is 80k→40k right?") is answered here, in
 * config: COMPACT_AT_TOKENS sets the live-window threshold that triggers a
 * compaction epoch, COMPACT_TO_TOKENS sets how many recent tokens the epoch
 * keeps. The window manager maps these onto the SDK's relative
 * reserveTokens/keepRecentTokens against the resolved model's contextWindow.
 */
export interface CompactionConfig {
  /** Trigger compaction when the live window reaches this many tokens. */
  compactAtTokens: number;
  /** Keep only this many recent tokens after a compaction epoch. */
  compactToTokens: number;
}

export interface DaemonConfig {
  /** Host to bind the gateway server to. Default "127.0.0.1". */
  host: string;
  /** Port to bind the gateway server to. Default 8080. */
  port: number;
  /** Path to the persona directory (charter, few-shots, etc.). Default "./persona". */
  personaDir: string;
  /** Auto-compaction policy in absolute token counts. */
  compaction: CompactionConfig;
  /** Optional model configuration. */
  model?: {
    provider: string;
    id: string;
    thinking?: ThinkingLevel;
  };
  /**
   * Cheap model used for background passes (summary consolidation,
   * extraction, eval). Defaults to the main model when unset.
   */
  cheapModel?: {
    provider: string;
    id: string;
  };
  /** Memory configuration. */
  memory?: MemoryConfig;
  /** Surface configuration. */
  surfaces: {
    discord?: {
      token?: string;
      allowedUsers?: string[];
    };
  };
}

export interface MemoryConfig {
  /** Path to the SQLite memory database. Default "./data/memory.db". */
  dbPath: string;
  /** Hugging Face model ID for local embeddings. Default "Xenova/bge-small-en-v1.5". */
  embeddingModel: string;
  /** Embedding dimensions. Must match the model. Default 384. */
  embeddingDims: number;
  /** Embedding provider settings. */
  embedding: {
    /** Which provider to use. Default "local". */
    provider: "local" | "sidecar";
    /** Sidecar URL, only used when provider is "sidecar". */
    sidecarUrl?: string;
  };
  /** Prefetch read-path tuning. */
  prefetch: {
    /** Top-K candidates from vector search. Default 16. */
    topK: number;
    /** Max tokens for rendered prefetch context. Default 300. */
    maxTokens: number;
    /** Minimum cosine similarity to bypass tag/entity overlap check. */
    strictCosine: number;
    /** Minimum combined score after recency decay and importance weighting. */
    scoreThreshold: number;
  };
}
