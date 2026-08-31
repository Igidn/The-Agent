import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { compactionInstructions } from "./compaction.js";
import type { WindowStats } from "./types.js";
import type { CompactionPlan } from "./compaction-settings.js";

/**
 * Tracks window state and provides manual compaction control.
 *
 * Owns the token-aware view of the session context: reads live token
 * counts from the SDK on demand, records the last compaction epoch,
 * and exposes the policy constants (threshold/target) so surfaces can
 * decide whether to show a busy or compacting state.
 *
 * Broadcasts stats through `onStatsUpdate`, which the gateway wires
 * into the WS channel.
 */
export class WindowManager {
  /** Timestamp of the most recent completed compaction epoch (manual or auto). */
  private _lastCompactionAt: number | null = null;

  /** Unsubscribe from session events. */
  private _unsub: (() => void) | null = null;

  /** Callback invoked when stats should be broadcast after a turn or compaction. */
  private _onStatsUpdate: ((stats: WindowStats) => void) | null = null;

  /**
   * @param session  The active AgentSession (set after SessionManager.start()).
   * @param plan     Compaction plan from applyCompactionSettings().
   */
  constructor(
    private _session: AgentSession,
    private _plan: CompactionPlan,
  ) {
    this._subscribe();
  }

  /** Register or replace the stats broadcast callback. */
  setOnStatsUpdate(cb: (stats: WindowStats) => void): void {
    this._onStatsUpdate = cb;
  }

  /** Current compact policy: the trigger threshold in tokens. */
  get threshold(): number {
    return this._plan.threshold;
  }

  /** Current compact policy: the target size in tokens after an epoch. */
  get target(): number {
    return this._plan.target;
  }

  /** Timestamp of the last completed compaction, or null if none. */
  get lastCompactionAt(): number | null {
    return this._lastCompactionAt;
  }

  /** Build a live snapshot of the window state. */
  getStats(): WindowStats {
    const contextUsage = this._session.getContextUsage();
    const contextTokens = contextUsage?.tokens ?? null;

    return {
      contextTokens: contextTokens ?? 0,
      threshold: this._plan.threshold,
      target: this._plan.target,
      lastCompactionAt: this._lastCompactionAt,
    };
  }

  /**
   * Manually trigger a compaction epoch.
   *
   * Aborts the current agent operation first, then compacts with the
   * custom instructions from the design policy. Returns after completion.
   */
  async manualCompact(): Promise<void> {
    await this._session.compact(compactionInstructions());
  }

  /** Replace the session reference (e.g. after a session resume). */
  setSession(session: AgentSession): void {
    this._unsub?.();
    this._session = session;
    this._subscribe();
  }

  /** Graceful stop: unsubscribe from session events. */
  dispose(): void {
    this._unsub?.();
    this._unsub = null;
  }

  private _subscribe(): void {
    this._unsub?.();
    this._unsub = this._session.subscribe((event: AgentSessionEvent) => {
      this._onEvent(event);
    });
  }

  private _onEvent(event: AgentSessionEvent): void {
    // Track compaction epochs so surfaces see an accurate lastCompactionAt.
    if (event.type === "compaction_end" && !event.aborted && !event.willRetry) {
      this._lastCompactionAt = Date.now();
    }

    // Broadcast stats after every settled turn and after compaction ends.
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