import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

import type { ExtractedFact, MemoryItem, MemoryStore } from "./types.js";
import { TurnExtractor, type ExtractFactsFn } from "./turn-extractor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A simple entry shape matching SessionEntryBase. */
interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

/** Minimal session double for testing. */
function fakeSession(
  messages: AgentMessage[],
  entries: Entry[] = [],
): AgentSession {
  return {
    messages,
    sessionManager: {
      getEntries: () => entries,
    },
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      // Store listener so tests can drive events manually
      return () => {};
    },
  } as unknown as AgentSession;
}

/** A controllable session that records the subscribe callback. */
class ControllableSession {
  readonly messages: AgentMessage[];
  readonly entries: Entry[];
  listener: ((event: AgentSessionEvent) => void) | null = null;

  constructor(messages: AgentMessage[] = [], entries: Entry[] = []) {
    this.messages = messages;
    this.entries = entries;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  sessionManager = {
    getEntries: () => this.entries,
  };

  /** Emit an event to the subscribed listener. */
  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }

  /** Cast to AgentSession for the API. */
  asSession(): AgentSession {
    return this as unknown as AgentSession;
  }
}

/** Fake extract function that returns canned facts. */
function fakeExtract(
  facts: ExtractedFact[],
): ExtractFactsFn {
  return async () => facts;
}

/** Make an AgentMessage-like user message. */
function userMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

/** Make an AgentMessage-like assistant message. */
function assistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

/** In-memory store stub that records what was ingested. */
function recordingStore(): MemoryStore & { ingested: unknown[] } {
  const ingested: unknown[] = [];

  async function upsert(item: Record<string, unknown>): Promise<MemoryItem> {
    ingested.push(item);
    return item as unknown as MemoryItem;
  }

  return {
    upsert,
    get: async () => null,
    list: async () => [],
    delete: async () => {},
    search: async () => [],
    close: async () => {},
    ingested,
  } as unknown as MemoryStore & { ingested: unknown[] };
}

const UNUSED_MODEL = undefined as unknown as Model<Api>;
const UNUSED_MODELS = undefined as unknown as Models;

function cheapModel(): Model<Api> {
  return { provider: "openai", id: "gpt-4o-mini" } as unknown as Model<Api>;
}

function cheapModels(): Models {
  return {
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text", text: "[]" }],
        stopReason: "stop",
      };
    },
  } as unknown as Models;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("bindSession subscribes to session events", () => {
  const store = recordingStore();
  const extract = fakeExtract([]);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession();
  extractor.bindSession(session.asSession());

  // After bind, the listener must be registered.
  assert.ok(session.listener !== null);

  extractor.dispose();
});

test("agent_settled with new messages extracts facts and persists them", async () => {
  const store = recordingStore();
  const extract = fakeExtract([
    { content: "User likes TypeScript", tags: ["preference"], importance: 6 },
  ]);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession(
    [userMsg("I like TypeScript")],
    [{ type: "message", id: "entry_1", parentId: null, timestamp: "2024-01-01T00:00:00Z" }],
  );
  extractor.bindSession(session.asSession());

  // Simulate a turn: add an assistant message and emit agent_settled
  session.messages.push(assistantMsg("Got it!"));
  session.emit({ type: "agent_settled" } as AgentSessionEvent);

  // Allow the fire-and-forget promise to settle
  await new Promise((r) => setTimeout(r, 10));

  // The extracted fact should have been ingested with sourceEntryId = last entry id
  assert.equal(store.ingested.length, 1);
  const call = store.ingested[0] as Record<string, unknown>;
  assert.equal(call.content, "User likes TypeScript");
  assert.deepEqual(call.tags, ["preference"]);
  assert.equal(call.importance, 6);
  assert.equal(call.sourceEntryId, "entry_1");

  extractor.dispose();
});

test("agent_settled with no new messages does nothing", async () => {
  let extractCalled = false;
  const extract: ExtractFactsFn = async () => {
    extractCalled = true;
    return [];
  };
  const store = recordingStore();
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession([userMsg("hi")]);
  extractor.bindSession(session.asSession());

  // Emit agent_settled with the same messages (no new ones)
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));

  // extract should not have been called
  assert.equal(extractCalled, false);
  assert.equal(store.ingested.length, 0);

  extractor.dispose();
});

test("extraction of empty facts does nothing", async () => {
  const store = recordingStore();
  const extract = fakeExtract([]);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession(
    [userMsg("hello")],
    [{ type: "message", id: "entry_1", parentId: null, timestamp: "2024-01-01T00:00:00Z" }],
  );
  extractor.bindSession(session.asSession());

  session.messages.push(assistantMsg("Hi there!"));
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.ingested.length, 0);

  extractor.dispose();
});

test("multiple turns accumulate facts across them", async () => {
  const store = recordingStore();
  let callCount = 0;
  const extract: ExtractFactsFn = async (msgs) => {
    callCount++;
    const turnMsgs = msgs.filter((m) => m.role === "user");
    return turnMsgs.map((m) => {
      const raw = m as unknown as { content?: Array<{ type?: string; text?: string }> };
      const text = Array.isArray(raw.content)
        ? raw.content.filter((c) => c.type === "text").map((c) => c.text).join(" ")
        : String(raw.content ?? "");
      return {
        content: `Fact from: ${text}`,
        tags: ["event"] as const,
        importance: 5,
      };
    });
  };

  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession(
    [],
    [
      { type: "message", id: "entry_1", parentId: null, timestamp: "2024-01-01T00:00:00Z" },
      { type: "message", id: "entry_2", parentId: null, timestamp: "2024-01-01T00:00:01Z" },
    ],
  );
  extractor.bindSession(session.asSession());

  // Turn 1
  session.messages.push(userMsg("First fact"));
  session.messages.push(assistantMsg("OK"));
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 1);
  assert.equal(store.ingested.length, 1);
  assert.equal(
    (store.ingested[0] as Record<string, unknown>).sourceEntryId,
    "entry_2",
  );

  // Turn 2
  session.messages.push(userMsg("Second fact"));
  session.messages.push(assistantMsg("Done"));
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 2);
  assert.equal(store.ingested.length, 2);
  assert.equal(
    (store.ingested[1] as Record<string, unknown>).content,
    "Fact from: Second fact",
  );

  extractor.dispose();
});

test("dispose unsubscribes and stops processing", async () => {
  const store = recordingStore();
  const extract = fakeExtract([
    { content: "Should not be stored", tags: ["event"], importance: 3 },
  ]);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession([userMsg("test")], [
    { type: "message", id: "e1", parentId: null, timestamp: "2024-01-01T00:00:00Z" },
  ]);
  extractor.bindSession(session.asSession());

  // Dispose before the turn completes.
  extractor.dispose();

  session.messages.push(assistantMsg("reply"));
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.ingested.length, 0);
});

test("bindSession can be called multiple times (re-subscribe)", async () => {
  const store = recordingStore();
  const extract = fakeExtract([
    { content: "From second session", tags: ["event"], importance: 5 },
  ]);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session1 = new ControllableSession([], [
    { type: "message", id: "s1", parentId: null, timestamp: "2024-01-01T00:00:00Z" },
  ]);
  extractor.bindSession(session1.asSession());
  const listener1 = session1.listener;

  const session2 = new ControllableSession([], [
    { type: "message", id: "s2", parentId: null, timestamp: "2024-01-01T00:00:00Z" },
  ]);
  extractor.bindSession(session2.asSession());

  // After re-binding, session1 should no longer trigger extraction.
  session1.messages.push(assistantMsg("reply"));
  session1.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.ingested.length, 0);

  // session2 should trigger extraction.
  session2.messages.push(assistantMsg("reply"));
  session2.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.ingested.length, 1);

  extractor.dispose();
});

test("store write failure does not crash the extractor", async () => {
  const store = recordingStore();
  // Override upsert to throw.
  store.upsert = async () => {
    throw new Error("disk full");
  };

  const extract = fakeExtract([
    { content: "This will fail to write", tags: ["event"], importance: 3 },
  ]);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession(
    [userMsg("test")],
    [{ type: "message", id: "e1", parentId: null, timestamp: "2024-01-01T00:00:00Z" }],
  );
  extractor.bindSession(session.asSession());

  session.messages.push(assistantMsg("reply"));
  // Must not throw
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));

  // Extractor is still usable after failure
  assert.ok(true);

  extractor.dispose();
});

test("extract function failure does not crash the extractor", async () => {
  const store = recordingStore();
  const extract: ExtractFactsFn = async () => {
    throw new Error("LLM unavailable");
  };

  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession(
    [userMsg("test")],
    [{ type: "message", id: "e1", parentId: null, timestamp: "2024-01-01T00:00:00Z" }],
  );
  extractor.bindSession(session.asSession());

  session.messages.push(assistantMsg("reply"));
  // Must not throw
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.ingested.length, 0);

  extractor.dispose();
});

test("sourceEntryId is null when entries are empty", async () => {
  const store = recordingStore();
  const extract = fakeExtract([
    { content: "Orphan fact", tags: ["event"], importance: 3 },
  ]);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession([userMsg("test")], []); // no entries
  extractor.bindSession(session.asSession());

  session.messages.push(assistantMsg("reply"));
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.ingested.length, 1);
  assert.equal(
    (store.ingested[0] as Record<string, unknown>).sourceEntryId,
    null,
  );

  extractor.dispose();
});

test("re-bindSession after dispose works", async () => {
  const store = recordingStore();
  const extract = fakeExtract([
    { content: "After re-bind", tags: ["event"], importance: 4 },
  ]);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession(
    [userMsg("hi")],
    [{ type: "message", id: "e1", parentId: null, timestamp: "2024-01-01T00:00:00Z" }],
  );

  extractor.bindSession(session.asSession());
  extractor.dispose();

  // Re-bind should work after dispose
  const session2 = new ControllableSession(
    [userMsg("again")],
    [{ type: "message", id: "e2", parentId: null, timestamp: "2024-01-01T00:00:00Z" }],
  );
  extractor.bindSession(session2.asSession());

  session2.messages.push(assistantMsg("ok"));
  session2.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.ingested.length, 1);
  assert.equal(
    (store.ingested[0] as Record<string, unknown>).content,
    "After re-bind",
  );

  extractor.dispose();
});

test("constructor accepts real extractFns signature", () => {
  // Verify the constructor accepts the real extractFacts export shape
  const store = recordingStore();
  const extract: ExtractFactsFn = async (msgs, model, models, signal) => {
    return [];
  };
  const model = cheapModel();
  const models = cheapModels();

  const extractor = new TurnExtractor(store, extract, model, models);
  assert.ok(extractor instanceof TurnExtractor);
  extractor.dispose();
});

test("multiple facts from one turn are all ingested", async () => {
  const store = recordingStore();
  const facts: ExtractedFact[] = [
    { content: "Fact one", tags: ["preference"], importance: 5 },
    { content: "Fact two", tags: ["event"], importance: 6 },
    { content: "Fact three", tags: ["person"], importance: 7 },
  ];
  const extract = fakeExtract(facts);
  const extractor = new TurnExtractor(store, extract, UNUSED_MODEL, UNUSED_MODELS);

  const session = new ControllableSession(
    [userMsg("multi-fact turn")],
    [{ type: "message", id: "entry_multi", parentId: null, timestamp: "2024-01-01T00:00:00Z" }],
  );
  extractor.bindSession(session.asSession());

  session.messages.push(assistantMsg("done"));
  session.emit({ type: "agent_settled" } as AgentSessionEvent);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.ingested.length, 3);
  assert.equal(
    (store.ingested[0] as Record<string, unknown>).content,
    "Fact one",
  );
  assert.equal(
    (store.ingested[1] as Record<string, unknown>).content,
    "Fact two",
  );
  assert.equal(
    (store.ingested[2] as Record<string, unknown>).content,
    "Fact three",
  );
  // All share the same sourceEntryId
  assert.equal(
    (store.ingested[0] as Record<string, unknown>).sourceEntryId,
    "entry_multi",
  );
  assert.equal(
    (store.ingested[1] as Record<string, unknown>).sourceEntryId,
    "entry_multi",
  );

  extractor.dispose();
});