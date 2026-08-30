import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "./session.js";
import { type SurfaceId, wrapMessage } from "./wrapper.js";

export type QueueState = "idle" | "streaming";

export interface SurfaceQueueInfo {
  /** Number of messages waiting from this surface. */
  pending: number;
  /** Whether messages are currently being coalesced into a debounce window. */
  debouncing?: boolean;
}

export interface QueueStatus {
  /** Overall state of the session. */
  state: QueueState;
  /** Per-surface queue state. */
  surfaces: Record<SurfaceId, SurfaceQueueInfo>;
}


const ALL_SURFACES: SurfaceId[] = ["discord", "launcher", "dashboard", "cli"];

/**
 * Return a QueueStatus shell with every surface set to zero pending and
 * no debouncing. Used as the starting point for getStatus().
 */
function emptyStatus(state: QueueState): QueueStatus {
  const surfaces: Record<SurfaceId, SurfaceQueueInfo> = {} as Record<
    SurfaceId,
    SurfaceQueueInfo
  >;
  for (const s of ALL_SURFACES) {
    surfaces[s] = { pending: 0 };
  }
  return { state, surfaces };
}


interface DebounceState {
  timer: ReturnType<typeof setTimeout>;
  texts: string[];
  surface: SurfaceId;
}


interface QueuedMessage {
  text: string;
  surface: SurfaceId;
  timestamp: number;
}


/**
 * Owns the inbound message queue for the single session.
 *
 * Three-rule dispatch:
 *   - Idle → `session.prompt()` immediately.
 *   - Streaming from the **same** surface → `session.steer()` (interrupt).
 *   - Streaming from a **different** surface → enqueue in FIFO order;
 *     delivered one at a time as the session becomes idle.
 *
 * Rapid bursts from the same surface (e.g. three short Discord messages
 * in five seconds) are coalesced into a single wrapper after a short
 * debounce window.
 */
export class MessageQueue {
  /** Which surface is currently being processed, if any. */
  private activeSurface: SurfaceId | null = null;

  /** Per-surface debounce state. */
  private debounceStates = new Map<SurfaceId, DebounceState>();

  /** Messages queued because the session was streaming from another surface. */
  private pendingQueue: QueuedMessage[] = [];

  /** Per-surface count of messages sitting in `pendingQueue`. */
  private pendingCounts = new Map<SurfaceId, number>();

  /** Unsubscribe from session events. */
  private unsubEvent: (() => void) | null = null;

  /** Whether the session is known to be idle. Default true until first message. */
  private settled = true;


  /**
   * Debounce window in milliseconds.
   * Messages from the same surface arriving within this window are coalesced.
   */
  public readonly debounceWindowMs: number;

  constructor(
    private sessionManager: SessionManager,
    debounceWindowMs = 5_000,
  ) {
    this.debounceWindowMs = debounceWindowMs;
  }

  /**
   * Wire up session event subscription. Call after SessionManager.start().
   */
  start(): void {
    if (this.unsubEvent) return;
    this.unsubEvent = this.sessionManager.session.subscribe(
      (event: AgentSessionEvent) => {
        this._onSessionEvent(event);
      },
    );
  }


  /**
   * Enqueue a message from a surface.
   *
   * Trims the text and discards empty strings.
   * If the surface has an active debounce timer the message is coalesced
   * into the pending burst. Otherwise the three-rule dispatch applies.
   */
  async enqueue(text: string, surface: SurfaceId): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const existing = this.debounceStates.get(surface);
    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(trimmed);
      existing.timer = setTimeout(
        () => this._flushDebounce(existing),
        this.debounceWindowMs,
      );
      return;
    }


    const currentlyStreaming = !this.settled;

    if (currentlyStreaming && this.activeSurface !== null && surface !== this.activeSurface) {
      // Different surface while streaming → queue (no debounce needed).
      this._enqueuePending(trimmed, surface);
      return;
    }

    // Idle OR streaming from the same surface → process now with debounce.
    // The leading edge fires immediately; subsequent messages within the
    // window are coalesced and fire after the window closes.
    this._startDebounce(surface, trimmed);
    await this._dispatch(trimmed, surface);
  }

  /**
   * Return a snapshot of the current queue state.
   *
   * The `state` field reflects whether the session is idle or streaming.
   * `surfaces` gives per-surface pending counts and whether a debounce
   * window is currently open for that surface.
   */
  getStatus(): QueueStatus {
    const state: QueueState = this.settled ? "idle" : "streaming";
    const status = emptyStatus(state);

    for (const [surface, count] of this.pendingCounts) {
      status.surfaces[surface].pending = count;
    }

    for (const surface of this.debounceStates.keys()) {
      status.surfaces[surface].debouncing = true;
    }

    return status;
  }

  /**
   * Dispose the queue. Clears all timers and unsubscribes from session
   * events.
   */
  dispose(): void {
    this.unsubEvent?.();
    this.unsubEvent = null;
    for (const state of this.debounceStates.values()) {
      clearTimeout(state.timer);
    }
    this.debounceStates.clear();
    this.pendingQueue = [];
    this.pendingCounts.clear();
    this.activeSurface = null;
    this.settled = true;
  }


  private _startDebounce(surface: SurfaceId, text: string): void {
    const state: DebounceState = {
      timer: setTimeout(() => this._flushDebounce(state), this.debounceWindowMs),
      texts: [text],
      surface,
    };
    this.debounceStates.set(surface, state);
  }

  private _flushDebounce(state: DebounceState): void {
    this.debounceStates.delete(state.surface);
    const combined = state.texts.join("\n");

    // Don't process an empty coalesced payload.
    if (!combined.trim()) return;

    // The session may have become idle or the active surface may have
    // changed since the timer was set. Re-evaluate.
    this._dispatch(combined, state.surface);
  }


  private _enqueuePending(text: string, surface: SurfaceId): void {
    this.pendingQueue.push({ text, surface, timestamp: Date.now() });
    this.pendingCounts.set(
      surface,
      (this.pendingCounts.get(surface) ?? 0) + 1,
    );
  }

  /**
   * Take the next message from the FIFO pending queue and dispatch it.
   * Call this when the session settles and there are queued messages.
   */
  private _drainPending(): void {
    while (this.pendingQueue.length > 0) {
      // Only drain if the session is still idle. If a dispatch starts
      // streaming, stop draining.
      if (!this.settled) return;

      const next = this.pendingQueue.shift()!;
      const current = this.pendingCounts.get(next.surface) ?? 0;
      if (current <= 1) {
        this.pendingCounts.delete(next.surface);
      } else {
        this.pendingCounts.set(next.surface, current - 1);
      }

      // Fire-and-forget: the dispatch will set settled=false and the next
      // drain will happen on agent_settled.
      this._dispatch(next.text, next.surface);
    }
  }


  /**
   * Core dispatch: apply the three-rule decision and call into the
   * session manager.
   *
   * Returns a promise that resolves once the SDK call has been made
   * (not when the model finishes streaming).
   */
  private async _dispatch(text: string, surface: SurfaceId): Promise<void> {
    const wrapped = wrapMessage(text, surface);

    if (this.settled) {
      // Rule 1: idle → prompt immediately.
      this.activeSurface = surface;
      this.settled = false;
      await this.sessionManager.prompt(wrapped.content);
    } else if (surface === this.activeSurface) {
      // Rule 2: streaming from same surface → steer.
      await this.sessionManager.steer(wrapped.content);
    } else if (this.activeSurface !== null) {
      // Rule 3: streaming from different surface → followUp (queue).
      // This path can be reached from the debounce flush when the timer
      // fires after the active surface changed.
      this._enqueuePending(text, surface);
    }
    // else: streaming but no active surface set → treat as idle (shouldn't happen).
  }


  private _onSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_settled") {
      this.settled = true;
      this.activeSurface = null;

      // Process any messages queued while the session was streaming.
      this._drainPending();
    }
  }
}