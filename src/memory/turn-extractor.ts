import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

import type { ExtractedFact, MemoryStore } from "./types.js";
import { ingestFact } from "./extract.js";

// ---------------------------------------------------------------------------
// ExtractFactsFn
// ---------------------------------------------------------------------------

/**
 * Signature that the turn extractor accepts for fact extraction.
 *
 * Matches the `extractFacts` export from `extract.ts` so callers can pass it
 * directly, and tests can inject a fake.
 */
export type ExtractFactsFn = (
  messages: AgentMessage[],
  model: Model<Api>,
  models: Models,
  signal?: AbortSignal,
) => Promise<ExtractedFact[]>;

// ---------------------------------------------------------------------------
// TurnExtractor
// ---------------------------------------------------------------------------

/**
 * Per-turn fact extraction trigger.
 *
 * Subscribes to session events and, after every completed turn
 * (`agent_settled`), extracts facts from the messages that arrived since
 * the last turn.  Extracted facts are persisted via `ingestFact` with a
 * `sourceEntryId` that points to the last session entry, so the read-side
 * invariant (`LiveWindow.isLive`) can exclude them while their segment is
 * still in the window.
 *
 * All work is fire-and-forget: extraction must never block the session.
 * Errors at any stage are logged and silently dropped.
 */
export class TurnExtractor {
  /** Unsubscribe from session events. */
  private _unsub: (() => void) | null = null;

  private _session: AgentSession | null = null;

  /** Messages processed up to this index. */
  private _lastMessageCount = 0;

  /**
   * @param store     The memory store to persist extracted facts.
   * @param extract   The fact-extraction function (typically `extractFacts`).
   * @param model     The model to use for extraction calls.
   * @param models    The Models collection for making LLM calls.
   */
  constructor(
    private readonly _store: MemoryStore,
    private readonly _extract: ExtractFactsFn,
    private readonly _model: Model<Api>,
    private readonly _models: Models,
  ) {}

  /**
   * Start listening for session events.
   *
   * Records the current message count so that only messages arriving after
   * this point are considered for extraction.  Safe to call multiple times
   * (re-subscribes).
   */
  bindSession(session: AgentSession): void {
    this._unsub?.();
    this._session = session;
    this._lastMessageCount = session.messages.length;
    this._unsub = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "agent_settled") {
        this._onSettled().catch((err) => {
          console.warn("TurnExtractor: extraction failed", err);
        });
      }
    });
  }

  /**
   * Unsubscribe from session events and release references.
   *
   * Safe to call multiple times or before `bindSession`.
   */
  dispose(): void {
    this._unsub?.();
    this._unsub = null;
    this._session = null;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  /**
   * React to a settled agent turn.
   *
   * Computes the delta of messages since the last extraction, calls the
   * extract function, and persists each fact.  All failures are caught and
   * logged so the session is never blocked.
   */
  private async _onSettled(): Promise<void> {
    const session = this._session;
    if (!session) return;

    const messages = session.messages;
    const prevCount = this._lastMessageCount;
    const currentCount = messages.length;

    // Update the cursor even when there is nothing new, so the next
    // turn's delta is correct.
    this._lastMessageCount = currentCount;

    if (currentCount <= prevCount) return;

    const newMessages = messages.slice(prevCount);

    let facts: ExtractedFact[];
    try {
      facts = await this._extract(newMessages, this._model, this._models);
    } catch {
      return; // LLM call failed; extractFacts itself catches most errors.
    }

    if (facts.length === 0) return;

    // Resolve the last session entry id for the sourceEntryId linkage so
    // the read path can exclude these facts while their segment is live.
    let sourceEntryId: string | null = null;
    try {
      const entries = session.sessionManager.getEntries();
      const lastEntry = entries[entries.length - 1];
      sourceEntryId = lastEntry?.id ?? null;
    } catch {
      // If entries are inaccessible, store with null — prefetch will
      // treat the fact as always eligible, which is safe (though
      // slightly over-eager).
    }

    for (const fact of facts) {
      try {
        await ingestFact(this._store, fact, sourceEntryId);
      } catch (err) {
        console.warn(
          `TurnExtractor: failed to persist fact "${fact.content.slice(0, 60)}"`,
          err,
        );
      }
    }
  }
}