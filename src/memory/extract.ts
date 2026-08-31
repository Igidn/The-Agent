import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Models,
  TextContent,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type {
  ExtractedFact,
  ExtractionDecision,
  MemoryTag,
  MemoryStore,
  ScoredItem,
} from './types.js';

/**
 * System prompt for the fact-extraction pass.
 *
 * Instructs the model to pull structured facts from a conversation segment
 * and return them as a JSON array.  Small talk yields nothing; only
 * information useful across future turns is kept.
 */
const EXTRACT_SYSTEM_PROMPT = [
  'Extract important facts from the conversation below. Return ONLY a valid JSON array. No markdown fences, no commentary.',
  '',
  'Each fact object must have:',
  '- "content": a concise statement of the fact (one sentence).',
  '- "tags": array of zero or more of "preference", "person", "event", "project", "correction", "summary".',
  '- "importance": integer 0–10 (10 = critical for future turns, 0 = trivial).',
  '',
  'Rules:',
  '- Omit filler, tool call logs, and generic pleasantries.',
  '- Prefer factual statements the user would want the agent to remember.',
  '- A correction tag means the fact supersedes or corrects a previously stored belief.',
  '- Return [] when nothing worth storing is present.',
  '',
  'Example:',
  '[{"content": "User prefers concise responses with bullet points", "tags": ["preference"], "importance": 7}]',
].join('\n');

/**
/**
 * Call the LLM and parse out a JSON array of ExtractedFact objects.
 *
 * Model is injected so tests can supply a mock. Returns an empty array on
 * parse failure rather than throwing, so TurnExtractor never blocks.
 */
export async function extractFacts(
  messages: AgentMessage[],
  model: Model<Api>,
  models: Models,
  signal?: AbortSignal,
): Promise<ExtractedFact[]> {
  if (messages.length === 0) return [];

  const conversation = messages
    .map((msg) => {
      const m = msg as unknown as Record<string, unknown>;
      const role = typeof m.role === 'string' ? m.role : 'unknown';
      if ('content' in m && Array.isArray(m.content)) {
        const texts = (m.content as Array<{ type?: string; text?: string }>)
          .filter(
            (c): c is { type: string; text: string } =>
              c.type === 'text' && typeof c.text === 'string',
          )
          .map((c) => c.text);
        if (texts.length > 0) return `${role}: ${texts.join(' ')}`;
      }
      if ((role === 'toolResult' || role === 'tool') && typeof m.toolCallId === 'string') {
        return `[tool result for ${m.toolCallId}]`;
      }
      return `[${role} message]`;
    })
    .join('\n');

  const userMessage: Message = {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: conversation }],
    timestamp: Date.now(),
  };

  const context: Context = {
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    messages: [userMessage],
  };

  let reply: AssistantMessage;
  try {
    reply = await models.complete(model, context, { signal });
  } catch {
    return [];
  }

  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
    return [];
  }

  const text = reply.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('');

  return parseExtractedFacts(text);
}

/**
 * Parse model output as JSON array. Strips markdown fences, leading/
 * trailing whitespace, and any text before `[` or after `]`. Returns an
 * empty array on any failure.
 */
function parseExtractedFacts(text: string): ExtractedFact[] {
  const cleaned = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*$/g, '')
    .trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  const json = cleaned.slice(start, end + 1);

  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        content: typeof item.content === 'string' ? item.content : '',
        tags: parseTags(item.tags),
        importance:
          typeof item.importance === 'number' &&
          Number.isInteger(item.importance) &&
          item.importance >= 0 &&
          item.importance <= 10
            ? item.importance
            : -1, // sentinel: filtered out below
      }))
      .filter(
        (f) => f.content.length > 0 && f.tags.length > 0 && f.importance >= 0 && f.importance <= 10,
      );
  } catch {
    return [];
  }
}

const VALID_TAGS: readonly MemoryTag[] = [
  'preference',
  'person',
  'event',
  'project',
  'correction',
  'summary',
];

function parseTags(raw: unknown): MemoryTag[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is MemoryTag => typeof t === 'string' && VALID_TAGS.includes(t as MemoryTag),
  );
}

/**
 * System prompt for the ADD/UPDATE/DELETE/NOOP decision.
 *
 * Implements a mem0-style comparison between a newly extracted fact and the
 * top candidates already in the index.
 */
const DECIDE_SYSTEM_PROMPT = [
  'You are a memory management system. Given a new fact and a list of existing similar facts, decide what to do.',
  '',
  'Return a JSON object with one of these actions:',
  '- {"action": "ADD"} — the fact is novel and should be stored as a new entry.',
  '- {"action": "UPDATE", "targetId": "<id>"} — the fact updates or refines an existing entry; provide the target entry id.',
  '- {"action": "DELETE", "targetId": "<id>"} — the fact contradicts or supersedes an existing entry, so that entry should be removed.',
  '- {"action": "NOOP"} — the fact is already well-covered by existing entries; nothing to do.',
  '',
  'Return ONLY the JSON object. No markdown fences, no commentary.',
].join('\n');

/**
 * Decide whether and how to merge a newly extracted fact into the index.
 *
 * @param fact       The fact just extracted from a conversation turn.
 * @param candidates Top candidates from `store.search` (tag/entity overlap
 *                   preferred so the LLM has context for the decision).
 * @param model      Cheap model for the decision call.
 * @param models     pi-ai Models collection.
 * @param signal     Optional abort signal.
 */
export async function decideUpsert(
  fact: ExtractedFact,
  candidates: ScoredItem[],
  model: Model<Api>,
  models: Models,
  signal?: AbortSignal,
): Promise<ExtractionDecision> {
  const existing = candidates
    .map(
      (c, i) =>
        `[${i}] id=${c.item.id} tags=${c.item.tags.join(',')} importance=${c.item.importance} cosine=${c.cosine.toFixed(3)}\n${c.item.content}`,
    )
    .join('\n\n');

  const userMessage: Message = {
    role: 'user' as const,
    content: [
      {
        type: 'text' as const,
        text: [
          'New fact:',
          `  content: ${fact.content}`,
          `  tags: ${fact.tags.join(', ')}`,
          `  importance: ${fact.importance}`,
          '',
          existing.length > 0
            ? `Existing candidates:\n${existing}`
            : 'No existing candidates match.',
        ].join('\n'),
      },
    ],
    timestamp: Date.now(),
  };

  const context: Context = {
    systemPrompt: DECIDE_SYSTEM_PROMPT,
    messages: [userMessage],
  };

  let reply: AssistantMessage;
  try {
    reply = await models.complete(model, context, { signal });
  } catch {
    return { action: 'ADD' }; // Degrade: add as new on error.
  }

  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
    return { action: 'ADD' };
  }

  const text = reply.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('');

  return parseDecision(text);
}

function parseDecision(text: string): ExtractionDecision {
  const cleaned = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*$/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { action: 'ADD' };
  }

  try {
    const parsed: Record<string, unknown> = JSON.parse(cleaned.slice(start, end + 1));
    const action = parsed.action as string;
    if (action === 'ADD' || action === 'NOOP') return { action };
    if (action === 'UPDATE' || action === 'DELETE') {
      return {
        action,
        targetId: typeof parsed.targetId === 'string' ? parsed.targetId : undefined,
      };
    }
    return { action: 'ADD' };
  } catch {
    return { action: 'ADD' };
  }
}

/**
 * Write an extracted fact into the store with deduplication.
 *
 * Steps:
 * 1. Search the store for similar content (kNN + tag-key overlap).
 * 2. When the fact carries a `correction` tag and a matching item is found,
 *    update that item's content and importance instead of creating a duplicate.
 * 3. Otherwise insert as a new episodic entry.
 *
 * @param store         The memory store (already open).
 * @param fact          Extracted fact to persist.
 * @param sourceEntryId Session entry id this fact was extracted from, so the
 *                      read-side invariant can filter it while the segment is live.
 */
export async function ingestFact(
  store: MemoryStore,
  fact: ExtractedFact,
  sourceEntryId: string | null,
): Promise<void> {
  // Search both tiers for similar content (kNN + tag-key overlap). The
  // design's dedupe runs against profile and episodic; a novel fact that
  // merely restates a profile item should NOOP, not double up.
  const candidates = await store.search(fact.content, 10);

  // Find the best textual match among candidates.
  const match = findBestTagKeyMatch(fact, candidates);

  if (match !== null && fact.tags.includes('correction')) {
    // Correction: update the existing item in place.
    await store.upsert({
      id: match.item.id,
      tier: match.item.tier,
      content: fact.content,
      tags: [...new Set([...match.item.tags, ...fact.tags])],
      entities: match.item.entities,
      importance: Math.max(match.item.importance, fact.importance),
      sourceEntryId: match.item.sourceEntryId, // Keep original provenance.
    });
    return;
  }

  if (match !== null) {
    // Already covered well enough — skip.
    return;
  }

  // Novel fact: insert as episodic.
  await store.upsert({
    tier: 'episodic',
    content: fact.content,
    tags: fact.tags,
    entities: undefined,
    importance: fact.importance,
    sourceEntryId,
  });
}

/**
 * Score candidates by tag overlap and content similarity. Returns the best
 * match or null when nothing exceeds the overlap threshold.
 *
 * Uses word-overlap instead of an extra embedding call. Tag+keyword matching
 * prevents false positives like "gaming" vs "games night".
 */
function findBestTagKeyMatch(fact: ExtractedFact, candidates: ScoredItem[]): ScoredItem | null {
  if (candidates.length === 0) return null;

  const factWords = new Set(
    fact.content
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((w) => w.length > 2),
  );

  let best: ScoredItem | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    // Tag overlap: at least one shared tag required.
    const sharedTags = candidate.item.tags.filter((t) => fact.tags.includes(t));
    if (sharedTags.length === 0) continue;

    // Word overlap ratio.
    const candidateWords = new Set(
      candidate.item.content
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((w) => w.length > 2),
    );
    const intersection = new Set([...factWords].filter((w) => candidateWords.has(w)));
    const union = new Set([...factWords, ...candidateWords]);
    const wordOverlap = union.size > 0 ? intersection.size / union.size : 0;

    // Composite score: cosine (from kNN) + wordOverlap + sharedTag bonus.
    const score = candidate.cosine + wordOverlap * 0.5 + (sharedTags.length > 1 ? 0.3 : 0.1);

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // Threshold: the composite must be meaningful.
  if (bestScore < 0.3) return null;

  return best;
}
