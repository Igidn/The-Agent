import type { Api, AssistantMessage, Message, Model, Usage } from '@earendil-works/pi-ai';
import { wrapMessage } from '../core/wrapper.js';
import { runChecks } from './checks.js';
import { completeEvalTurn, type LlmTurnResult } from './llm.js';
import type { CaseResult, EvalCase, EvalRunResult } from './types.js';

export { runCompactionEval } from './compaction.js';
export type { CompactionCaseResult, CompactionEvalRunResult } from './compaction.js';

/** Per-case wall clock limit. A hung provider call must not stall the run. */
const CASE_TIMEOUT_MS = 180_000;

/** Bookkeeping usage for replayed history turns. The provider only reads role and content. */
const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface RunnerOptions {
  model: Model<Api>;
  systemPrompt: string;
  cases: readonly EvalCase[];
  /** How many cases to run at once. Default 4. */
  concurrency?: number;
  /** ISO timestamp of run start; stamped into the result. */
  startedAt: string;
  /** Persona directory the system prompt was loaded from; stamped into the result. */
  personaDir: string;
}

/**
 * Build the message list for one case the same way the daemon would:
 * every history user turn goes through wrapMessage with its own surface,
 * history assistant turns are replayed as plain text turns, and the bait
 * message is wrapped last, carrying the memory-context block when the
 * case has one.
 */
function buildCaseMessages(evalCase: EvalCase, model: Model<Api>): Message[] {
  const messages: Message[] = [];

  for (const turn of evalCase.history ?? []) {
    if (turn.role === 'user') {
      const wrapped = wrapMessage(turn.text, turn.surface);
      messages.push({ role: 'user', content: wrapped.content, timestamp: Date.now() });
      continue;
    }

    const replayed: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: turn.text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    messages.push(replayed);
  }

  const final = wrapMessage(evalCase.message, evalCase.surface, evalCase.memoryContext);
  messages.push({ role: 'user', content: final.content, timestamp: Date.now() });

  return messages;
}

/** Run one case end to end: call, checks, verdict. Never throws. */
async function runCase(
  model: Model<Api>,
  systemPrompt: string,
  evalCase: EvalCase,
): Promise<CaseResult> {
  const messages = buildCaseMessages(evalCase, model);

  let turn: LlmTurnResult;
  try {
    turn = await Promise.race([
      completeEvalTurn(model, systemPrompt, messages),
      new Promise<LlmTurnResult>((_, reject) => {
        setTimeout(
          () => reject(new Error(`timed out after ${CASE_TIMEOUT_MS}ms`)),
          CASE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    return { evalCase, reply: '', checks: [], passed: false, error: (err as Error).message };
  }

  if (turn.errorMessage !== undefined) {
    return { evalCase, reply: turn.text, checks: [], passed: false, error: turn.errorMessage };
  }

  const checks = runChecks(turn.text, evalCase.expect);
  return { evalCase, reply: turn.text, checks, passed: checks.every((c) => c.pass) };
}

/**
 * Run the whole suite through one model with a small worker pool, logging
 * each verdict as it lands. Results come back in case order regardless of
 * completion order, so two runs of the same suite diff cleanly.
 */
export async function runEval(options: RunnerOptions): Promise<EvalRunResult> {
  const concurrency = options.concurrency ?? 4;
  const queue = options.cases.map((evalCase, index) => ({ evalCase, index }));
  const collected: Array<{ index: number; result: CaseResult }> = [];

  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;

      const result = await runCase(options.model, options.systemPrompt, next.evalCase);
      collected.push({ index: next.index, result });

      const verdict = result.passed ? 'PASS' : 'FAIL';
      const note = result.error !== undefined ? ` (${result.error})` : '';
      console.log(`${verdict}  ${result.evalCase.id} [${result.evalCase.category}]${note}`);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const results = collected.sort((a, b) => a.index - b.index).map((entry) => entry.result);

  return {
    startedAt: options.startedAt,
    model: `${options.model.provider}/${options.model.id}`,
    personaDir: options.personaDir,
    results,
  };
}
