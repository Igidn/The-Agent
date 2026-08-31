import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Models, Usage } from "@earendil-works/pi-ai";

import type { CompactionConfig } from "../../shared/types.js";
import { compactionInstructions, consolidateSummary } from "./compaction.js";
import type { CompactionEvent, CompactionSink, LiveWindow, WindowStats } from "./types.js";

/** Same signature as the SDK's generateSummaryWithUsage. */
export type SummaryFn = typeof generateSummaryWithUsage;
/** Same signature as our consolidateSummary. */
export type ConsolidateFn = typeof consolidateSummary;

export interface WindowManagerOptions {
  /** Replace the summarization call (tests). */
  summarize?: SummaryFn;
  /** Replace the consolidation call (tests). */
  consolidate?: ConsolidateFn;
  /** Consolidate the summary chain once it passes this token estimate. */
  consolidationBudgetTokens?: number;
  /** Cheap model for background passes. Defaults to the session model. */
  cheapModel?: { provider: string; id: string };
}

/** Matches the SDK's SessionBeforeCompactResult. */
type BeforeCompactResult = {
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage?: Usage;
  };
};

/**
 * Owns the window policy at compaction boundaries.
 *
 * Rides the SDK's compaction hooks rather than driving its own trigger:
 * the SDK watches usage per turn and decides when to compact (including
 * overflow recovery); this extension supplies the custom summary the
 * design's preserve/drop policy demands, journals every epoch to the
 * {@link CompactionSink}, tracks the live-window boundary for the memory
 * read path, and fires `onBoundary` callbacks — the one sanctioned
 * system-prompt mutation point, where the prompt cache is already dead.
 *
 * Register the factory returned by {@link extension} as an inline
 * extension on the session's resource loader, then call
 * {@link bindSession} once the session exists.
 */
export class WindowManager {
  /** Timestamp of the most recent completed compaction epoch. */
  private _lastCompactionAt: number | null = null;

  /** Entry id of the oldest live message. Null until the first epoch. */
  private _boundaryEntryId: string | null = null;

  /** Rolling summaries of past epochs, oldest first. */
  private _chain: string[] = [];

  /** Dropped segment captured at session_before_compact, consumed at session_compact. */
  private _pendingDropped: Parameters<SummaryFn>[0] | null = null;

  /** Boundary callbacks. Fired only from session_compact. */
  private _boundaryCallbacks: Array<() => Promise<void> | void> = [];

  private _session: AgentSession | null = null;
  private _unsub: (() => void) | null = null;
  private _onStatsUpdate: ((stats: WindowStats) => void) | null = null;

  private readonly _summarize: SummaryFn;
  private readonly _consolidate: ConsolidateFn;
  private readonly _consolidationBudget: number;

  /**
   * @param policy  The design's absolute token counts (compactAt/compactTo).
   * @param sink    Receives one CompactionEvent per completed epoch.
   */
  constructor(
    private _policy: CompactionConfig,
    private _sink: CompactionSink,
    private _options: WindowManagerOptions = {},
  ) {
    this._summarize = _options.summarize ?? generateSummaryWithUsage;
    this._consolidate = _options.consolidate ?? consolidateSummary;
    // Default: a fifth of the post-compaction target, floor 2k tokens.
    this._consolidationBudget =
      _options.consolidationBudgetTokens ??
      Math.max(2_000, Math.floor(_policy.compactToTokens / 5));
  }

  /**
   * Inline extension riding the compaction hooks. Must be registered on
   * the resource loader before createAgentSession so handlers are bound
   * for both the automatic and the manual compaction paths.
   */
  extension(): { name: string; hidden: boolean; factory: ExtensionFactory } {
    return {
      name: "window-manager",
      hidden: true,
      factory: (pi: ExtensionAPI) => {
        pi.on("session_before_compact", async (
          event: SessionBeforeCompactEvent,
          ctx: ExtensionContext,
        ) => this._onBeforeCompact(event, ctx));

        pi.on("session_compact", (event: SessionCompactEvent) =>
          this._onCompacted(event));

        pi.on("session_compact_failed", (event) =>
          this._onCompactFailed(event));
      },
    };
  }

  /**
   * Bind the session once it exists. Re-subscribes the stats broadcast
   * if called again (e.g. after a session resume).
   */
  bindSession(session: AgentSession): void {
    this._unsub?.();
    this._session = session;
    this._unsub = session.subscribe((event: AgentSessionEvent) =>
      this._onSessionEvent(event));
  }

  /** Register or replace the stats broadcast callback. */
  setOnStatsUpdate(cb: (stats: WindowStats) => void): void {
    this._onStatsUpdate = cb;
  }

  /**
   * Register a callback fired after every completed compaction epoch.
   * This is the one sanctioned system-prompt mutation point: the cache
   * is already dead from the summary rewrite, so profile/charter section
   * swaps are safe here and nowhere else.
   */
  onBoundary(cb: () => Promise<void> | void): void {
    this._boundaryCallbacks.push(cb);
  }

  /** Current compact policy: the trigger threshold in tokens. */
  get threshold(): number {
    return this._policy.compactAtTokens;
  }

  /** Current compact policy: the target size in tokens after an epoch. */
  get target(): number {
    return this._policy.compactToTokens;
  }

  /** Timestamp of the last completed compaction, or null if none. */
  get lastCompactionAt(): number | null {
    return this._lastCompactionAt;
  }

  /** Read-side eligibility contract for the memory prefetch path. */
  get liveWindow(): LiveWindow {
    return {
      boundaryEntryId: this._boundaryEntryId,
      isLive: (entryId: string): boolean => {
        if (this._boundaryEntryId === null) return true;
        const session = this._session;
        if (session === null) return true;
        const entries = session.sessionManager.getEntries();
        const boundaryIndex = entries.findIndex(
          (e) => e.id === this._boundaryEntryId,
        );
        // Boundary not on the current branch (fork/switch): cannot tell,
        // treat everything as live so prefetch under-filters, never over.
        if (boundaryIndex < 0) return true;
        return entries.some(
          (e, i) => i >= boundaryIndex && e.id === entryId,
        );
      },
    };
  }

  /** Build a live snapshot of the window state. */
  getStats(): WindowStats {
    const contextUsage = this._session?.getContextUsage();
    return {
      contextTokens: contextUsage?.tokens ?? 0,
      threshold: this._policy.compactAtTokens,
      target: this._policy.compactToTokens,
      lastCompactionAt: this._lastCompactionAt,
    };
  }

  /**
   * Manually trigger a compaction epoch (dashboard backstop). Goes
   * through session.compact, so the hook supplies the same custom
   * summary as the automatic path.
   */
  async manualCompact(): Promise<void> {
    if (this._session === null) {
      throw new Error("WindowManager: session not bound yet");
    }
    await this._session.compact(compactionInstructions());
  }

  /** Graceful stop: unsubscribe from session events. */
  dispose(): void {
    this._unsub?.();
    this._unsub = null;
  }

  // ------------------------------------------------------------------
  // Hook handlers
  // ------------------------------------------------------------------

  /**
   * Produce a custom summary for the compaction epoch, or degrade to the
   * SDK's default summary when the model is unavailable or the call fails.
   * The summary is built from the dropped segment (messages to summarize)
   * and the previous summary chain (possibly consolidated).
   */
  private async _onBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<BeforeCompactResult | void> {
    const preparation = event.preparation;
    this._pendingDropped = preparation.messagesToSummarize;

    if (ctx.model === undefined) {
      this._pendingDropped = null;
      return;
    }

    try {
      const previousSummary = await this._chainPreviousSummary(event, ctx);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      const model =
        auth.ok && auth.baseUrl !== undefined
          ? { ...ctx.model, baseUrl: auth.baseUrl }
          : ctx.model;

      const { text, usage } = await this._summarize(
        preparation.messagesToSummarize,
        model,
        preparation.settings.reserveTokens,
        auth.ok ? auth.apiKey : undefined,
        auth.ok ? (auth.headers as Record<string, string> | undefined) : undefined,
        event.signal,
        compactionInstructions(),
        previousSummary,
        undefined, // thinkingLevel
        undefined, // streamFn
        auth.ok ? auth.env : undefined,
      );

      return {
        compaction: {
          summary: text,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage,
        },
      };
    } catch (err) {
      this._pendingDropped = null;
      console.warn(
        "Compaction: custom summary failed; falling back to SDK default",
        err,
      );
    }
  }

  /**
   * Journal a completed compaction epoch to the sink and fire boundary
   * callbacks. Consumes the pending dropped messages captured by
   * {@link _onBeforeCompact}.
   */
  private async _onCompacted(event: SessionCompactEvent): Promise<void> {
    const dropped = this._pendingDropped;
    this._pendingDropped = null;

    const entry = event.compactionEntry;
    const previousSummaries = [...this._chain];
    this._chain.push(entry.summary);
    this._boundaryEntryId = entry.firstKeptEntryId;
    this._lastCompactionAt = Date.now();

    const compactionEvent: CompactionEvent = {
      summary: entry.summary,
      previousSummaries,
      droppedMessages: dropped ?? [],
      firstKeptEntryId: entry.firstKeptEntryId,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date().toISOString(),
    };

    await this._sink.recordCompaction(compactionEvent);

    for (const cb of this._boundaryCallbacks) {
      try {
        await cb();
      } catch (err) {
        console.warn("Compaction: boundary callback failed", err);
      }
    }
  }

  private _onCompactFailed(event: {
    reason: string;
    aborted: boolean;
    errorMessage?: string;
  }): void {
    this._pendingDropped = null;
    console.warn(
      `Compaction: epoch failed (${event.reason}${event.aborted ? ", aborted" : ""})` +
        `${event.errorMessage ? `: ${event.errorMessage}` : ""}`,
    );
  }

  /**
   * Decide what reaches generateSummaryWithUsage as previousSummary.
   *
   * The SDK merges iteratively, so a lean chain just passes the last
   * summary through. Once the accumulated chain passes the consolidation
   * budget it is merged into one summary first, so repeated epochs can
   * never push the window back toward the compaction threshold on
   * summary weight alone.
   */
  /**
   * Build the previousSummary input for the summarization call.
   *
   * When the accumulated summary chain exceeds the consolidation budget,
   * the chain is merged into a single consolidated summary before being
   * passed through, preventing summary weight from pushing the window
   * back toward the compaction threshold.
   */
  private async _chainPreviousSummary(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<string | undefined> {
    const prev = event.preparation.previousSummary;
    if (prev === undefined) {
      this._chain = [];
      return undefined;
    }

    const candidates = [...new Set([...this._chain, prev])];

    if (this._estimateTokens(candidates) <= this._consolidationBudget) {
      return prev;
    }

    const cheapModel = this._resolveCheapModel(ctx);
    try {
      const consolidated = await this._consolidate(
        candidates,
        cheapModel,
        ctx.modelRegistry as unknown as Models,
        event.signal,
      );
      this._chain = [consolidated.text];
      return consolidated.text;
    } catch (err) {
      console.warn(
        "Compaction: chain consolidation failed; passing the chain through",
        err,
      );
      return prev;
    }
  }

  private _resolveCheapModel(ctx: ExtensionContext): Model<Api> {
    const configured = this._options.cheapModel;
    if (configured !== undefined) {
      const found = ctx.modelRegistry.find(configured.provider, configured.id);
      if (found !== undefined) return found;
      console.warn(
        `Compaction: cheap model ${configured.provider}/${configured.id} ` +
          `not found; using the session model`,
      );
    }
    if (ctx.model === undefined) {
      throw new Error("Compaction: no model available for consolidation");
    }
    return ctx.model;
  }

  /** chars/4 heuristic, same one the SDK's estimateTokens uses. */
  private _estimateTokens(summaries: string[]): number {
    return Math.ceil(
      summaries.reduce((n, s) => n + s.length, 0) / 4,
    );
  }

  // ------------------------------------------------------------------
  // Stats broadcast
  // ------------------------------------------------------------------

  /**
   * React to session lifecycle events: update the last compaction
   * timestamp and broadcast window stats.
   */
  private _onSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "compaction_end" && !event.aborted && !event.willRetry) {
      this._lastCompactionAt = Date.now();
    }

    if (
      event.type === "agent_settled" ||
      (event.type === "compaction_end" && !event.aborted && !event.willRetry)
    ) {
      this._broadcast();
    }
  }

  private _broadcast(): void {
    if (this._onStatsUpdate) {
      this._onStatsUpdate(this.getStats());
    }
  }
}
