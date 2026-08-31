export type SurfaceId = "discord" | "launcher" | "dashboard" | "cli";

export interface WrappedMessage {
  /** The full wrapped text including <message> and optional <memory-context> tags. */
  content: string;
  /** Which surface the message came from. */
  surface: SurfaceId;
  /** ISO 8601 timestamp of when the message was wrapped. */
  timestamp: string;
}

/**
 * Origins that map to each surface. The parser checks these substrings
 * to decide which SurfaceId a message origin belongs to.
 */
const SURFACE_ORIGIN_MAP: Record<SurfaceId, string[]> = {
  discord: ["discord.com", "discordapp.com", "discord"],
  launcher: ["launcher", "vicinae"],
  dashboard: ["dashboard", "localhost:3000", "127.0.0.1"],
  cli: ["cli", "terminal", "stdin"],
};

/**
 * SurfaceId values ordered by specificity. Used when multiple origins
 * match unexpectedly — the first match in this array wins.
 */
const SURFACE_PRECEDENCE: SurfaceId[] = [
  "discord",
  "dashboard",
  "launcher",
  "cli",
];

/**
 * Parse a surface identifier from an origin string.
 *
 * Checks known substrings mapped to each surface. Returns "cli" when
 * nothing matches. The caller can pass a URL, a process name, or any
 * label the transport layer knows about.
 *
 *   parseSurfaceFromOrigin("discord.com/channel/123") // "discord"
 *   parseSurfaceFromOrigin("launcher")                // "launcher"
 *   parseSurfaceFromOrigin("ssh://some-host")         // "cli"
 */
export function parseSurfaceFromOrigin(origin: string): SurfaceId {
  const lower = origin.toLowerCase();

  for (const surface of SURFACE_PRECEDENCE) {
    const patterns = SURFACE_ORIGIN_MAP[surface];
    for (const pattern of patterns) {
      if (lower.includes(pattern)) {
        return surface;
      }
    }
  }

  return "cli";
}

/**
 * Build a wrapped message string.
 *
 * Produces a <message> tag with the surface and timestamp attributes,
 * followed by the text. When memoryContext is provided and non-empty,
 * a <memory-context> block is appended. The memory-context token
 * budget is ~300 tokens — callers should truncate before passing it.
 *
 *   wrapMessage("yo did you see that pr", "discord")
 *   // <message surface="discord" time="2025-08-30T18:04Z">
 *   //   yo did you see that pr
 *   // </message>
 *
 *   wrapMessage("whats on today", "dashboard", "- calendar: standup at 10")
 *   // <message surface="dashboard" time="2025-08-30T18:04Z">
 *   //   whats on today
 *   // </message>
 *   // <memory-context>
 *   //   - calendar: standup at 10
 *   // </memory-context>
 */
export function wrapMessage(
  text: string,
  surface: SurfaceId,
  memoryContext?: string,
): WrappedMessage {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const trimmed = text.trim();

  let content = `<message surface="${surface}" time="${timestamp}">\n`;
  content += `  ${trimmed}\n`;
  content += `</message>`;

  if (memoryContext !== undefined && memoryContext.trim().length > 0) {
    const context = memoryContext.trim();
    content += `\n<memory-context>\n${context}\n</memory-context>`;
  }

  return { content, surface, timestamp };
}