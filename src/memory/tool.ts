import { type Static, Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import type { MemoryConfig } from "../shared/types.js";
import type { MemoryStore, ScoredItem } from "./types.js";

const memorySearchParams = Type.Object({
  query: Type.String({ description: "Search query for memory recall" }),
  k: Type.Optional(
    Type.Number({
      description: "Number of results to return (default 10)",
    }),
  ),
});

type MemorySearchParams = Static<typeof memorySearchParams>;

/**
 * Create a `memory_search` tool that performs explicit memory recall.
 *
 * Unlike prefetch, this tool bypasses the live-window eligibility gate.
 * The user asked, so the read-side invariant does not apply.
 *
 * Tool responses are new suffix content, cache-safe by nature.
 */
export function createMemorySearchTool(
  store: MemoryStore,
  _cfg: MemoryConfig,
): ToolDefinition<typeof memorySearchParams> {
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search past conversation history and stored facts. " +
      "Use when you need to recall something specific the user said or decided earlier. " +
      "Returns relevant memories ranked by similarity.",

    parameters: memorySearchParams,

    async execute(
      _toolCallId: string,
      params: MemorySearchParams,
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: unknown,
    ) {
      try {
        const results = await store.search(params.query, params.k ?? 10);

        const content: TextContent[] = [];

        if (results.length === 0) {
          content.push({ type: "text", text: "No matching memories found." });
        } else {
          const lines = formatResults(results);
          for (const line of lines) {
            content.push({ type: "text", text: line });
          }
        }

        return { content, details: {} };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
        };
      }
    },
  };
}

/**
 * Format scored search results into readable lines.
 *
 * Each result is rendered as a bullet point with tier, tags, importance,
 * and a similarity indicator.
 */
function formatResults(results: ScoredItem[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    const item = result.item;
    const tagStr = item.tags.length > 0 ? item.tags.join(", ") : "none";
    lines.push(
      `- [${item.tier}] (${(result.cosine * 100).toFixed(0)}% · importance ${item.importance} · tags: ${tagStr}`,
    );
    lines.push(`  ${item.content}`);
  }
  return lines;
}