import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentSession,
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';

import { compactionInstructions } from './compaction.js';
import { WindowManager, type SummaryFn, type ConsolidateFn } from './window-manager.js';
import type { CompactionEvent, CompactionSink } from './types.js';
import type { CompactionConfig } from '../../config/index.js';

const POLICY: CompactionConfig = { compactAtTokens: 80000, compactToTokens: 40000 };

const USAGE: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A sink that records every event it receives. */
class RecordingSink implements CompactionSink {
  readonly events: CompactionEvent[] = [];
  async recordCompaction(event: CompactionEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Grab the handlers an extension factory registers, keyed by event name. */
function registerExtension(wm: WindowManager): Map<string, (event: never, ctx: never) => unknown> {
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const fakePi = {
    on: (event: string, handler: (e: never, c: never) => unknown) => {
      handlers.set(event, handler);
    },
  };
  wm.extension().factory(fakePi as unknown as ExtensionAPI);
  return handlers;
}

function fakeBeforeEvent(overrides?: {
  previousSummary?: string;
  messages?: unknown[];
}): SessionBeforeCompactEvent {
  return {
    type: 'session_before_compact',
    preparation: {
      firstKeptEntryId: 'kept-1',
      messagesToSummarize: (overrides?.messages ?? [{ role: 'user', content: 'hi' }]) as never,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 80000,
      previousSummary: overrides?.previousSummary,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 120000, keepRecentTokens: 40000 },
    },
    branchEntries: [],
    customInstructions: undefined,
    reason: 'threshold',
    willRetry: false,
    signal: new AbortController().signal,
  } as unknown as SessionBeforeCompactEvent;
}

function fakeCtx(model = { provider: 'p', id: 'm', contextWindow: 200000 }) {
  return {
    model: model as never,
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true as const, apiKey: 'test-key' };
      },
      find: () => model as never,
    },
  };
}

function fakeCompactedEvent(summary: string): SessionCompactEvent {
  return {
    type: 'session_compact',
    compactionEntry: {
      type: 'compaction',
      id: 'entry-1',
      parentId: null,
      timestamp: '2025-08-30T00:00:00Z',
      summary,
      firstKeptEntryId: 'kept-1',
      tokensBefore: 80000,
      fromHook: true,
    },
    fromExtension: true,
    reason: 'threshold',
    willRetry: false,
  } as unknown as SessionCompactEvent;
}

/** Minimal session double: entry list for LiveWindow, nothing else needed. */
function fakeSession(entryIds: string[] = ['a', 'b', 'c']): AgentSession {
  const entries = entryIds.map((id) => ({ id, parentId: null, type: 'message' }));
  return {
    subscribe: () => () => {},
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => entries },
  } as unknown as AgentSession;
}

test('before-compact supplies the custom summary with the design instructions', async () => {
  const calls: unknown[][] = [];
  const summarize: SummaryFn = (async (...args: unknown[]) => {
    calls.push(args);
    return { text: 'custom summary', usage: USAGE };
  }) as unknown as SummaryFn;

  const wm = new WindowManager(POLICY, new RecordingSink(), { summarize });
  const handlers = registerExtension(wm);
  const result = await (
    handlers.get('session_before_compact') as unknown as (
      e: SessionBeforeCompactEvent,
      c: unknown,
    ) => Promise<unknown>
  )(fakeBeforeEvent(), fakeCtx());

  assert.deepEqual(result, {
    compaction: {
      summary: 'custom summary',
      firstKeptEntryId: 'kept-1',
      tokensBefore: 80000,
      usage: USAGE,
    },
  });
  // The design's preserve/drop policy rides as custom instructions
  // (argument 6 of generateSummaryWithUsage), previousSummary is argument 7.
  assert.equal(calls[0]?.[6], compactionInstructions());
  // Resolved auth reaches the provider call.
  assert.equal(calls[0]?.[3], 'test-key');
});

test('before-compact with no model steps aside so the SDK path handles it', async () => {
  const summarize: SummaryFn = (() => {
    throw new Error('must not be called');
  }) as unknown as SummaryFn;

  const wm = new WindowManager(POLICY, new RecordingSink(), { summarize });
  const handlers = registerExtension(wm);
  const result = await (
    handlers.get('session_before_compact') as unknown as (
      e: SessionBeforeCompactEvent,
      c: unknown,
    ) => Promise<unknown>
  )(fakeBeforeEvent(), fakeCtx(undefined));

  assert.equal(result, undefined);
});

test('a failed custom summary degrades to the SDK default, not a failed epoch', async () => {
  const summarize: SummaryFn = (async () => {
    throw new Error('provider down');
  }) as unknown as SummaryFn;

  const wm = new WindowManager(POLICY, new RecordingSink(), { summarize });
  const handlers = registerExtension(wm);
  const result = await (
    handlers.get('session_before_compact') as unknown as (
      e: SessionBeforeCompactEvent,
      c: unknown,
    ) => Promise<unknown>
  )(fakeBeforeEvent(), fakeCtx());

  assert.equal(result, undefined);
});

test('a fat summary chain is consolidated before it reaches the summarizer', async () => {
  const consolidateCalls: string[][] = [];
  const consolidate: ConsolidateFn = (async (summaries: string[]) => {
    consolidateCalls.push(summaries);
    return { text: 'merged summary', usage: USAGE };
  }) as unknown as ConsolidateFn;
  const seenPrevious: unknown[] = [];
  const summarize: SummaryFn = (async (...args: unknown[]) => {
    seenPrevious.push(args[7]);
    return { text: 'next', usage: USAGE };
  }) as unknown as SummaryFn;

  const wm = new WindowManager(POLICY, new RecordingSink(), {
    summarize,
    consolidate,
    consolidationBudgetTokens: 100,
  });
  const handlers = registerExtension(wm);

  const fat = 'x'.repeat(1000); // ~250 tokens, over the 100-token budget
  await (
    handlers.get('session_before_compact') as unknown as (
      e: SessionBeforeCompactEvent,
      c: unknown,
    ) => Promise<unknown>
  )(fakeBeforeEvent({ previousSummary: fat }), fakeCtx());

  assert.equal(consolidateCalls.length, 1);
  assert.deepEqual(consolidateCalls[0], [fat]);
  assert.equal(seenPrevious[0], 'merged summary');
});

test('a lean chain passes the previous summary through untouched', async () => {
  const consolidate: ConsolidateFn = (() => {
    throw new Error('must not consolidate');
  }) as unknown as ConsolidateFn;
  const seenPrevious: unknown[] = [];
  const summarize: SummaryFn = (async (...args: unknown[]) => {
    seenPrevious.push(args[7]);
    return { text: 'next', usage: USAGE };
  }) as unknown as SummaryFn;

  const wm = new WindowManager(POLICY, new RecordingSink(), { summarize, consolidate });
  const handlers = registerExtension(wm);

  await (
    handlers.get('session_before_compact') as unknown as (
      e: SessionBeforeCompactEvent,
      c: unknown,
    ) => Promise<unknown>
  )(fakeBeforeEvent({ previousSummary: 'short' }), fakeCtx());

  assert.equal(seenPrevious[0], 'short');
});

test('session_compact journals the epoch, moves the boundary, fires onBoundary once', async () => {
  const sink = new RecordingSink();
  const summarize: SummaryFn = (async () => ({
    text: 'custom summary',
    usage: USAGE,
  })) as unknown as SummaryFn;
  const wm = new WindowManager(POLICY, sink, { summarize });
  wm.bindSession(fakeSession());
  const boundaryCalls: number[] = [];
  wm.onBoundary(() => {
    boundaryCalls.push(Date.now());
  });
  const handlers = registerExtension(wm);

  const dropped = [{ role: 'user', content: 'old' }];
  // First the before-compact hook captures the dropped segment...
  await (
    handlers.get('session_before_compact') as unknown as (
      e: SessionBeforeCompactEvent,
      c: unknown,
    ) => Promise<unknown>
  )(fakeBeforeEvent({ messages: dropped }), fakeCtx());
  // ...then the SDK reports success.
  await (handlers.get('session_compact') as unknown as (e: SessionCompactEvent) => Promise<void>)(
    fakeCompactedEvent('the summary'),
  );

  assert.equal(sink.events.length, 1);
  const event = sink.events[0];
  assert.equal(event.summary, 'the summary');
  assert.deepEqual(event.droppedMessages, dropped);
  assert.equal(event.firstKeptEntryId, 'kept-1');
  assert.equal(event.tokensBefore, 80000);
  assert.ok(event.timestamp.endsWith('Z'));

  assert.equal(boundaryCalls.length, 1);
  assert.equal(wm.liveWindow.boundaryEntryId, 'kept-1');
});

test('liveWindow filters entries by their position against the boundary', async () => {
  const wm = new WindowManager(POLICY, new RecordingSink());
  wm.bindSession(fakeSession(['a', 'b', 'c']));
  const handlers = registerExtension(wm);

  // Nothing compacted yet: everything is live.
  assert.equal(wm.liveWindow.isLive('a'), true);

  await (handlers.get('session_compact') as unknown as (e: SessionCompactEvent) => Promise<void>)(
    fakeCompactedEvent('s'),
  );

  assert.equal(wm.liveWindow.boundaryEntryId, 'kept-1');
  // Boundary "kept-1" is not in the entry list; cannot tell, so
  // everything stays live rather than prefetch under-filtering.
  assert.equal(wm.liveWindow.isLive('a'), true);
});

test('a boundary that exists in the entry list splits live from dropped', async () => {
  const wm = new WindowManager(POLICY, new RecordingSink());
  wm.bindSession(fakeSession(['a', 'b', 'c']));
  const handlers = registerExtension(wm);

  const event = fakeCompactedEvent('s');
  (event.compactionEntry as { firstKeptEntryId: string }).firstKeptEntryId = 'b';
  await (handlers.get('session_compact') as unknown as (e: SessionCompactEvent) => Promise<void>)(
    event,
  );

  assert.equal(wm.liveWindow.isLive('a'), false);
  assert.equal(wm.liveWindow.isLive('b'), true);
  assert.equal(wm.liveWindow.isLive('c'), true);
});

test('session_compact_failed keeps the boundary and journals nothing', async () => {
  const sink = new RecordingSink();
  const summarize: SummaryFn = (async () => ({
    text: 'custom summary',
    usage: USAGE,
  })) as unknown as SummaryFn;
  const wm = new WindowManager(POLICY, sink, { summarize });
  wm.bindSession(fakeSession(['a', 'b', 'c']));
  const handlers = registerExtension(wm);

  // A successful epoch first, so there is a boundary to defend.
  const ok = fakeCompactedEvent('first');
  (ok.compactionEntry as { firstKeptEntryId: string }).firstKeptEntryId = 'b';
  await (handlers.get('session_compact') as unknown as (e: SessionCompactEvent) => Promise<void>)(
    ok,
  );

  // A pending before-compact that never completes.
  await (
    handlers.get('session_before_compact') as unknown as (
      e: SessionBeforeCompactEvent,
      c: unknown,
    ) => Promise<unknown>
  )(fakeBeforeEvent(), fakeCtx());

  (handlers.get('session_compact_failed') as unknown as (e: unknown) => void)({
    type: 'session_compact_failed',
    reason: 'threshold',
    aborted: false,
    errorMessage: 'boom',
  });

  assert.equal(sink.events.length, 1);
  assert.equal(wm.liveWindow.boundaryEntryId, 'b');
});
