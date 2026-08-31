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
  /** Surface configuration. */
  surfaces: {
    discord?: {
      token?: string;
      allowedUsers?: string[];
    };
  };
}