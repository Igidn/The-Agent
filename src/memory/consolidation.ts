import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Models,
  TextContent,
} from "@earendil-works/pi-ai";
import type { MemoryItem, MemoryStore, MemoryTag } from "./types.js";

// ---------------------------------------------------------------------------
// consolidateProfile
// ---------------------------------------------------------------------------

/**
 * System prompt for the profile consolidation pass.
 *
 * Instructs the model to merge existing profile information with recent
 * episodic facts into a concise, deduplicated set of profile statements.
 */
const CONSOLIDATE_SYSTEM_PROMPT = [
  "You consolidate user profile information from conversation records into a concise, non-redundant set of profile statements.",
  "",
  "You are given:",
  "- Existing profile items (current knowledge about the user).",
  "- Recent episodic facts (things learned from recent conversations).",
  "",
  "Return ONLY a valid JSON array of profile statement objects. No markdown fences, no commentary.",
  "",
  "Each object must have:",
  '- "content": a concise factual statement about the user (one sentence).',
  '- "tags": array of one or more of "preference", "person", "event", "project", "correction", "summary".',
  '- "importance": integer 0–10 (10 = most important to remember).',
  "",
  "Rules:",
  "- Merge duplicate or overlapping information into a single statement.",
  "- Prefer the most recent information when there is a conflict.",
  "- Drop outdated facts that are superseded by newer information.",
  "- Keep the overall set small (dozens of items, not hundreds).",
  "- Include both stable traits (preferences, personal details) and active context (current projects, recent events).",
  "- Each statement should be independently meaningful out of context.",
  "",
  "Example:",
  '[{"content": "User prefers concise responses with bullet points", "tags": ["preference"], "importance": 7}]',
].join("\n");

/** Tags that can contribute to the profile tier. */
const PROFILE_RELEVANT_TAGS: MemoryTag[] = [
  "preference",
  "person",
  "project",
  "event",
  "correction",
  "summary",
];

/**
 * Consolidate profile information from episodic memory and the existing
 * profile tier.
 *
 * Steps:
 * 1. Fetch all existing profile items and recent episodic items with
 *    profile-relevant tags.
 * 2. Send both sets to the LLM for consolidation.
 * 3. Delete all existing profile items.
 * 4. Insert the new consolidated profile items.
 * 5. Return the new items.
 *
 * Produces dozens of items, not hundreds.
 *
 * @param store   The memory store (already open, both tiers populated).
 * @param model   Cheap model (e.g. Gemini Flash, GPT-4o-mini).
 * @param models  pi-ai `Models` collection used to make the completion call.
 * @param signal  Optional abort signal forwarded to the provider call.
 */
export async function consolidateProfile(
  store: MemoryStore,
  model: Model<Api>,
  models: Models,
  signal?: AbortSignal,
): Promise<MemoryItem[]> {
  const [existingProfile, recentEpisodic] = await Promise.all([
    store.list({ tier: "profile" }),
    store.list({
      tier: "episodic",
      tags: PROFILE_RELEVANT_TAGS,
      limit: 200,
    }),
  ]);

  const existingSection =
    existingProfile.length > 0
      ? existingProfile
          .map(
            (item, i) =>
              `[${i}] tags=${item.tags.join(",")} importance=${item.importance}\n${item.content}`,
          )
          .join("\n\n")
      : "(none)";

  const episodicSection =
    recentEpisodic.length > 0
      ? recentEpisodic
          .map(
            (item, i) =>
              `[${i}] tags=${item.tags.join(",")} importance=${item.importance}\n${item.content}`,
          )
          .join("\n\n")
      : "(none)";

  const userMessage: Message = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: [
          "Existing profile items:",
          existingSection,
          "",
          "Recent episodic facts:",
          episodicSection,
        ].join("\n"),
      },
    ],
    timestamp: Date.now(),
  };

  const context: Context = {
    systemPrompt: CONSOLIDATE_SYSTEM_PROMPT,
    messages: [userMessage],
  };

  let reply: AssistantMessage;
  try {
    reply = await models.complete(model, context, { signal });
  } catch (err) {
    throw new Error(
      `consolidateProfile: provider call failed - ${(err as Error).message}`,
    );
  }

  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(
      `consolidateProfile: provider returned ${reply.stopReason} - ${reply.errorMessage ?? "no details"}`,
    );
  }

  const text = reply.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");

  const profileStatements = parseProfileStatements(text);
  if (profileStatements.length === 0) {
    return existingProfile;
  }

  await Promise.all(
    existingProfile.map((item) => store.delete(item.id)),
  );

  const newItems: MemoryItem[] = [];
  for (const stmt of profileStatements) {
    const item = await store.upsert({
      tier: "profile",
      content: stmt.content,
      tags: stmt.tags,
      importance: stmt.importance,
      sourceEntryId: null,
    });
    newItems.push(item);
  }

  return newItems;
}

// ---------------------------------------------------------------------------
// Parsing helper
// ---------------------------------------------------------------------------

interface ProfileStatement {
  content: string;
  tags: MemoryTag[];
  importance: number;
}

const VALID_TAGS: readonly MemoryTag[] = [
  "preference",
  "person",
  "event",
  "project",
  "correction",
  "summary",
];

/**
 * Parse model output as a JSON array of profile statements.
 * Strips markdown fences and recovers the JSON payload.
 */
function parseProfileStatements(text: string): ProfileStatement[] {
  const cleaned = text
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```\s*$/g, "")
    .trim();

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];

  const json = cleaned.slice(start, end + 1);

  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
      .map((item) => ({
        content: typeof item.content === "string" ? item.content : "",
        tags: parseTags(item.tags),
        importance:
          typeof item.importance === "number" &&
          Number.isInteger(item.importance) &&
          item.importance >= 0 &&
          item.importance <= 10
            ? item.importance
            : -1,
      }))
      .filter(
        (s) =>
          s.content.length > 0 &&
          s.tags.length > 0 &&
          s.importance >= 0 &&
          s.importance <= 10,
      );
  } catch {
    return [];
  }
}

function parseTags(raw: unknown): MemoryTag[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is MemoryTag =>
      typeof t === "string" && VALID_TAGS.includes(t as MemoryTag),
  );
}

// ---------------------------------------------------------------------------
// renderProfileSection
// ---------------------------------------------------------------------------

/**
 * Render a list of profile MemoryItems into a string block for the system
 * prompt profile section.
 *
 * The output is placed between `<!-- profile -->` and `<!-- /profile -->`
 * markers by `Charter.prototype.setProfileSection`.
 *
 * Returns an empty string when the list is empty, so the caller can omit
 * the section entirely.
 */
export function renderProfileSection(items: MemoryItem[]): string {
  if (items.length === 0) return "";

  const lines = ["=== User Profile ==="];
  for (const item of items) {
    lines.push(`- ${item.content}`);
  }

  return lines.join("\n");
}