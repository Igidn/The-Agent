import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  TextContent,
  Usage,
} from '@earendil-works/pi-ai';

/**
 * Custom instructions appended to the SDK's summarization prompt on every
 * compaction epoch. Encodes the window policy from the design: what must
 * survive the drop and what the memory index already covers.
 *
 * Pass this as the `customInstructions` argument to
 * `generateSummaryWithUsage()` or `session.compact()`.
 */
export function compactionInstructions(): string {
  const preserve = [
    'open threads and ongoing conversations',
    'active projects and what state they are in',
    'decisions made and the reasoning behind them',
    'commitments the agent made ("I\'ll check on that", "I\'ll follow up")',
    'people and roles under discussion',
    'tone anchors: how the user talks, shared references, register preferences',
  ].join(', ');

  const drop = [
    'tool call invocations and their outputs (bash logs, file reads, edit confirmations)',
    'filler and small talk that carries no decisions or context',
    'superseded back-and-forth resolved by a later exchange',
    'old <memory-context> blocks (already in the memory index; keeping them double-counts)',
  ].join(', ');

  return [
    `Preserve these in the summary: ${preserve}.`,
    `Drop these from the summary: ${drop}.`,
    'Write the summary as structured sections (Goal, Progress, Key Decisions, Next Steps) so the next turn can pick up without reading the raw transcript.',
  ].join('\n');
}

/**
 * Result of a summary consolidation pass.
 * Matches the shape of `generateSummaryWithUsage` so consumers can swap
 * implementations without changing callers.
 */
export interface ConsolidationResult {
  text: string;
  usage: Usage;
}

/** Usage record for passes that make no provider call (nothing to merge). */
function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Consolidate a chain of rolling summaries into one.
 *
 * Repeated compaction epochs accumulate summaries. When the chain itself
 * pushes toward the context threshold this pass merges them into a single,
 * shorter summary.  Uses pi-ai `complete()` with a cheap model as specified
 * in the design: non-session LLM work goes through the direct provider API.
 *
 * @param summaries  Rolling summaries, oldest first.  Passed as-is when
 *                   there is nothing to consolidate (length < 2).
 * @param model      Cheap model instance (e.g. Gemini Flash, GPT-4o-mini)
 *                   resolved via `builtinModels()` or `ModelRuntime`.
 * @param models     pi-ai `Models` collection used to make the completion
 *                   call.  Pass `builtinModels()` or your wrapper.
 * @param signal     Optional abort signal forwarded to the provider call.
 * @param options    Optional configuration for token budget.
 */
export async function consolidateSummary(
  summaries: string[],
  model: Model<Api>,
  models: Models,
  signal?: AbortSignal,
  options?: { maxConsolidatedTokens?: number },
): Promise<ConsolidationResult> {
  if (summaries.length === 0) {
    return { text: '', usage: zeroUsage() };
  }

  if (summaries.length === 1) {
    return { text: summaries[0], usage: zeroUsage() };
  }

  const budget = options?.maxConsolidatedTokens ?? 4_000;

  const systemPrompt = [
    'You merge session summaries into one concise summary.',
    'Keep all open threads, active projects, decisions made, commitments, people under discussion, and tone anchors.',
    'Drop repetition, filler, tool spam, superseded back-and-forth, and old <memory-context> blocks.',
    'Output the consolidated summary in the same structured format: ## Goal, ## Progress, ## Key Decisions, ## Next Steps.',
    `Stay within a soft limit of ${budget} tokens.`,
  ].join('\n');

  const numbered = summaries.map((s, i) => `<summary index="${i}">\n${s}\n</summary>`).join('\n\n');

  const userMessage = [
    'Consolidate these summaries into one. Drop what is redundant or outdated; merge everything else.',
    '',
    numbered,
  ].join('\n');

  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text' as const, text: userMessage }],
        timestamp: Date.now(),
      },
    ],
  };

  let reply: AssistantMessage;
  try {
    reply = await models.complete(model, context, { signal });
  } catch (err) {
    throw new Error(`consolidateSummary: provider call failed - ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
    throw new Error(
      `consolidateSummary: provider returned ${reply.stopReason} - ${reply.errorMessage ?? 'no details'}`,
    );
  }

  const text = reply.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('');

  if (!text.trim()) {
    throw new Error('consolidateSummary: provider returned empty content');
  }

  return { text, usage: reply.usage };
}
