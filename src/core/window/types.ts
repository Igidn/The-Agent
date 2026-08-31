import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Read model of the window's token state, assembled on demand from pi SDK
 * accounting (`calculateContextTokens` over the session entries,
 * `getLastAssistantUsage` for the last turn's usage). Nothing produces this
 * continuously; the window manager builds it when a consumer asks.
 *
 * Threshold and target are policy constants owned by the window manager;
 * `contextTokens` is whatever the SDK reports. `lastCompactionAt` stays null
 * until the first epoch runs, so callers can tell "never compacted" apart
 * from "compacted long ago".
 */
export interface WindowStats {
  contextTokens: number;
  threshold: number;
  target: number;
  lastCompactionAt: number | null;
}

/**
 * Emitted once per compaction epoch. Every field maps straight onto hook
 * data from the compaction run, so the memory milestone never needs to
 * re-derive anything: it receives the prepared segment and the boundary
 * the session manager just wrote.
 */
export interface CompactionEvent {
  /** Rolling summary now prepended to the window (`prepareCompaction` output). */
  summary: string;
  /** Chain of `previousSummary` values, oldest first. */
  previousSummaries: string[];
  /** `preparation.messagesToSummarize`: the segment that left the window. */
  droppedMessages: AgentMessage[];
  /** `compactionEntry.firstKeptEntryId`: the new live-window boundary. */
  firstKeptEntryId: string;
  /** Context tokens at the moment the epoch started (`preparation.tokensBefore`). */
  tokensBefore: number;
  /** ISO 8601 timestamp of the epoch. */
  timestamp: string;
}

/**
 * Write-side port for compaction output. The memory milestone (build
 * order 5) implements this against the real index; v1 gets the audit sink,
 * which only journals events and keeps the pipeline testable.
 */
export interface CompactionSink {
  recordCompaction(event: CompactionEvent): Promise<void>;
}

/**
 * Read-side eligibility contract. Memory asks this before prefetching so the
 * invariant "prefetch never surfaces anything still live in the window" holds
 * even when the index holds items extracted from content that has not left the
 * window yet. Those items are stored but never retrieved.
 */
export interface LiveWindow {
  /** Entry id of the oldest live message; null when the window is empty. */
  boundaryEntryId: string | null;
  isLive(entryId: string): boolean;
}
