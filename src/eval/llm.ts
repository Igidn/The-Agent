import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Models,
  TextContent,
} from '@earendil-works/pi-ai';

/** Which model eval runs against, as provider/id. */
export interface EvalModelSpec {
  provider: string;
  id: string;
}

/** The raw outcome of one eval turn: reply text, or the failure. */
export interface LlmTurnResult {
  text: string;
  errorMessage?: string;
  usage?: { input: number; output: number; cost: number };
}

const models: Models = builtinModels();

/**
 * Resolve the eval model and verify the provider has auth configured,
 * before any case spends a turn on it. Fails loudly with the nearest
 * known model ids so a typo in --model or MODEL_ID is obvious.
 */
export async function resolveEvalModel(spec: EvalModelSpec): Promise<Model<Api>> {
  const model = models.getModel(spec.provider, spec.id);

  const auth = await models.checkAuth(spec.provider);
  if (!auth) {
    throw new Error(
      `Provider "${spec.provider}" has no auth configured. For OpenRouter set OPENROUTER_API_KEY (or put it in .env and run via npm run eval).`,
    );
  }

  if (model) {
    return model;
  }

  const known = models
    .getModels(spec.provider)
    .map((m) => m.id)
    .sort()
    .slice(0, 40);
  const hint =
    known.length > 0
      ? `Known ${spec.provider} models include: ${known.join(', ')}`
      : `Provider "${spec.provider}" is not in the catalog.`;
  throw new Error(`Model ${spec.provider}/${spec.id} not found. ${hint}`);
}

/**
 * Run one eval turn through pi-ai's complete(). No tools, no session:
 * eval exercises the persona against a bare chat call, which is how the
 * design routes non-session LLM work. Never throws; a failed call comes
 * back as an errorMessage so the runner can record it as a case error
 * instead of aborting the whole run.
 */
export async function completeEvalTurn(
  model: Model<Api>,
  systemPrompt: string,
  messages: Message[],
): Promise<LlmTurnResult> {
  const context: Context = { systemPrompt, messages };

  let reply: AssistantMessage;
  try {
    reply = await models.complete(model, context);
  } catch (err) {
    return { text: '', errorMessage: `request failed: ${(err as Error).message}` };
  }

  const text = reply.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('');

  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
    return { text, errorMessage: reply.errorMessage ?? `stop reason: ${reply.stopReason}` };
  }

  return {
    text,
    usage: {
      input: reply.usage.input,
      output: reply.usage.output,
      cost: reply.usage.cost.total,
    },
  };
}
