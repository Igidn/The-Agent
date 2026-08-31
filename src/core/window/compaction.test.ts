import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Api, Model, Models, Usage } from '@earendil-works/pi-ai';

import { compactionInstructions, consolidateSummary } from './compaction.js';
import type { ConsolidationResult } from './compaction.js';

/** A model/mock that must never be used; short-circuit paths skip it. */
const UNUSED_MODEL = undefined as unknown as Model<Api>;
const UNUSED_MODELS = undefined as unknown as Models;

test('compactionInstructions contains the preserve and drop lists', () => {
  const text = compactionInstructions();

  assert.ok(text.length > 0, 'should not be empty');

  const preserveSignals = [
    'open threads',
    'active projects',
    'decisions made',
    'commitments',
    'people',
    'tone anchors',
  ];
  for (const signal of preserveSignals) {
    assert.match(text.toLowerCase(), new RegExp(signal), `should mention preserving "${signal}"`);
  }

  const dropSignals = ['tool call invocations', 'filler', 'superseded', 'memory-context'];
  for (const signal of dropSignals) {
    assert.match(text.toLowerCase(), new RegExp(signal), `should mention dropping "${signal}"`);
  }
});

test('consolidateSummary with 0 summaries returns empty text and zero usage', async () => {
  const result = await consolidateSummary([], UNUSED_MODEL, UNUSED_MODELS);
  assert.equal(result.text, '');
  assertAllZero(result.usage);
});

test('consolidateSummary with 1 summary returns the same text and zero usage', async () => {
  const single = '## Goal\nTest task\n## Progress\nNothing done yet.';
  const result = await consolidateSummary([single], UNUSED_MODEL, UNUSED_MODELS);
  assert.equal(result.text, single);
  assertAllZero(result.usage);
});

test('consolidateSummary with 2+ summaries calls models.complete and returns the result', async () => {
  const summaries = [
    '## Goal\nBuild feature X\n## Progress\nStarted design',
    '## Goal\nBuild feature X\n## Progress\nDesign done, writing code',
  ];

  // Canned response from the provider.
  const cannedText = '## Goal\nBuild feature X\n## Progress\nDesign done, writing code';
  const cannedUsage: Usage = {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.003,
    },
  };

  // Minimal fake Models that records the call and returns the canned reply.
  let completeCallArgs: unknown[] | null = null;

  const fakeModels = {
    async complete(_model: unknown, _context: unknown, _options?: unknown) {
      completeCallArgs = [_model, _context];
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: cannedText }],
        usage: cannedUsage,
        stopReason: 'stop' as const,
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o-mini' as const,
        timestamp: Date.now(),
      };
    },
  } as unknown as Models;

  const fakeModel = { provider: 'openai', id: 'gpt-4o-mini' } as unknown as Model<Api>;

  const result: ConsolidationResult = await consolidateSummary(summaries, fakeModel, fakeModels);

  assert.equal(result.text, cannedText);
  assert.equal(result.usage.input, 100);
  assert.equal(result.usage.output, 50);
  assert.equal(result.usage.totalTokens, 150);

  // Verified the context that reaches the provider has both summaries in
  // the user message and a system prompt setting the merge policy.
  assert.ok(completeCallArgs !== null, 'models.complete should have been called');
  const [, context] = completeCallArgs as [unknown, { systemPrompt?: string; messages: unknown[] }];
  assert.ok(typeof context.systemPrompt === 'string', 'systemPrompt should be set');
  assert.equal(context.messages.length, 1);
  const msg = context.messages[0] as {
    role: string;
    content: { type: string; text: string }[];
  };
  assert.equal(msg.role, 'user');
  assert.ok(
    msg.content[0].text.includes('summary index="0"'),
    'user message should reference the first summary',
  );
  assert.ok(
    msg.content[0].text.includes('summary index="1"'),
    'user message should reference the second summary',
  );
});

test('consolidateSummary returns a ConsolidationResult shape', async () => {
  const result = await consolidateSummary([], UNUSED_MODEL, UNUSED_MODELS);
  assert.ok('text' in result);
  assert.ok('usage' in result);
  assert.equal(typeof result.text, 'string');
  assert.equal(typeof result.usage.input, 'number');
});

/** Assert every numeric field in a Usage object is exactly zero. */
function assertAllZero(usage: Usage): void {
  assert.equal(usage.input, 0);
  assert.equal(usage.output, 0);
  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.cost.input, 0);
  assert.equal(usage.cost.output, 0);
  assert.equal(usage.cost.cacheRead, 0);
  assert.equal(usage.cost.cacheWrite, 0);
  assert.equal(usage.cost.total, 0);
}
