import type { CompactionConfig, DaemonConfig, ThinkingLevel } from "../shared/types.js";

export type { CompactionConfig, DaemonConfig, ThinkingLevel };

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function isValidThinkingLevel(value: string): value is ThinkingLevel {
  return (VALID_THINKING_LEVELS as readonly string[]).includes(value);
}

function str(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== "" ? value.trim() : fallback;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseCommaList(value: string | undefined): string[] | undefined {
  if (!value || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(): DaemonConfig {
  const host = str(process.env.HOST, "127.0.0.1");
  const port = num(process.env.PORT, 8080);

  if (port < 1 || port > 65535 || !Number.isInteger(port)) {
    throw new Error(
      `PORT must be an integer between 1 and 65535, got ${port}`,
    );
  }

  const personaDir = str(process.env.PERSONA_DIR, "./persona");

  const compactAtTokens = num(process.env.COMPACT_AT_TOKENS, 80000);
  const compactToTokens = num(process.env.COMPACT_TO_TOKENS, 40000);

  if (!Number.isInteger(compactAtTokens) || compactAtTokens < 1) {
    throw new Error(
      `COMPACT_AT_TOKENS must be a positive integer, got ${compactAtTokens}`,
    );
  }
  if (!Number.isInteger(compactToTokens) || compactToTokens < 1) {
    throw new Error(
      `COMPACT_TO_TOKENS must be a positive integer, got ${compactToTokens}`,
    );
  }
  if (compactToTokens >= compactAtTokens) {
    throw new Error(
      "COMPACT_TO_TOKENS must be smaller than COMPACT_AT_TOKENS " +
        `(got ${compactToTokens} vs ${compactAtTokens})`,
    );
  }

  const modelProvider = process.env.MODEL_PROVIDER;
  const modelId = process.env.MODEL_ID;
  let model: DaemonConfig["model"] = undefined;

  if (modelProvider && modelId) {
    const thinkingRaw = process.env.MODEL_THINKING;
    let thinking: ThinkingLevel | undefined = undefined;

    if (thinkingRaw !== undefined && thinkingRaw.trim() !== "") {
      const trimmed = thinkingRaw.trim().toLowerCase();
      if (isValidThinkingLevel(trimmed)) {
        thinking = trimmed;
      } else {
        throw new Error(
          `MODEL_THINKING must be one of: ${VALID_THINKING_LEVELS.join(", ")}, got "${thinkingRaw}"`,
        );
      }
    }

    model = { provider: modelProvider, id: modelId, thinking };
  } else if (modelProvider || modelId) {
    throw new Error(
      "Both MODEL_PROVIDER and MODEL_ID must be set together to configure a model.",
    );
  }

  const cheapModelProvider = process.env.CHEAP_MODEL_PROVIDER;
  const cheapModelId = process.env.CHEAP_MODEL_ID;
  let cheapModel: DaemonConfig["cheapModel"] = undefined;

  if (cheapModelProvider && cheapModelId) {
    cheapModel = { provider: cheapModelProvider, id: cheapModelId };
  } else if (cheapModelProvider || cheapModelId) {
    throw new Error(
      "Both CHEAP_MODEL_PROVIDER and CHEAP_MODEL_ID must be set together " +
        "to configure a cheap model.",
    );
  }

  const discordToken = process.env.DISCORD_TOKEN;
  const discordAllowedUsers = parseCommaList(process.env.DISCORD_ALLOWED_USERS);

  const surfaces: DaemonConfig["surfaces"] = {};
  if (discordToken || discordAllowedUsers) {
    surfaces.discord = {
      ...(discordToken ? { token: discordToken } : {}),
      ...(discordAllowedUsers ? { allowedUsers: discordAllowedUsers } : {}),
    };
  }

  return {
    host,
    port,
    personaDir,
    compaction: { compactAtTokens, compactToTokens },
    model,
    cheapModel,
    surfaces,
  };
}