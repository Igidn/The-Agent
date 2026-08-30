import type { CaseExpectation, CheckResult } from "./types.js";
import { GLOBAL_BANNED_PHRASES } from "./banned.js";

/**
 * Find which of `phrases` occur in `text`. Case-insensitive, word-boundary
 * on both ends, and tolerant of any whitespace between words so a phrase
 * still matches across a line wrap. Word boundaries mean "pr" does not
 * match "pretty", so short mustNotMention tokens are safe. Phrases must
 * be lowercase; inflected forms need their own entry.
 */
export function findPhrases(text: string, phrases: readonly string[]): string[] {
  const hits: string[] = [];

  for (const phrase of phrases) {
    let pattern = "";
    for (const ch of phrase) {
      if (/[a-z0-9_]/.test(ch)) {
        pattern += ch;
      } else if (/\s/.test(ch)) {
        pattern += "\\s+";
      } else {
        pattern += `\\${ch}`;
      }
    }

    const startBoundary = /^[a-z0-9_]/.test(phrase) ? "\\b" : "";
    const endBoundary = /[a-z0-9_]$/.test(phrase) ? "\\b" : "";
    const matcher = new RegExp(`${startBoundary}${pattern}${endBoundary}`, "i");

    if (matcher.test(text)) {
      hits.push(phrase);
    }
  }

  return hits;
}

/**
 * Run every grep-style expectation against one reply and return the
 * verdicts in a stable order: banned phrases first (they apply to every
 * case), then the per-case expectations in the order they are declared.
 * A check with nothing to say is skipped, so an empty expectations object
 * yields only the global banned-phrase check.
 */
export function runChecks(reply: string, expect: CaseExpectation): CheckResult[] {
  const results: CheckResult[] = [];
  const text = reply.trim();

  const banned = [...GLOBAL_BANNED_PHRASES, ...(expect.bannedPhrases ?? [])];
  const bannedHits = findPhrases(text, banned);
  results.push({
    name: "no-banned-phrases",
    pass: bannedHits.length === 0,
    detail: bannedHits.length === 0 ? "" : `matched: ${bannedHits.join(", ")}`,
  });

  if (expect.mustMention !== undefined && expect.mustMention.length > 0) {
    const missing = expect.mustMention.filter((p) => !findPhrases(text, [p]).includes(p));
    results.push({
      name: "must-mention",
      pass: missing.length === 0,
      detail: missing.length === 0 ? "" : `missing: ${missing.join(", ")}`,
    });
  }

  if (expect.mustMentionAny !== undefined && expect.mustMentionAny.length > 0) {
    const hits = findPhrases(text, expect.mustMentionAny);
    results.push({
      name: "must-mention-any",
      pass: hits.length > 0,
      detail: hits.length > 0 ? `matched: ${hits[0]}` : `none of: ${expect.mustMentionAny.join(", ")}`,
    });
  }

  if (expect.mustNotMention !== undefined && expect.mustNotMention.length > 0) {
    const hits = findPhrases(text, expect.mustNotMention);
    results.push({
      name: "must-not-mention",
      pass: hits.length === 0,
      detail: hits.length === 0 ? "" : `matched: ${hits.join(", ")}`,
    });
  }

  if (expect.maxWords !== undefined) {
    const wordCount = text.length === 0 ? 0 : text.split(/\s+/).length;
    results.push({
      name: "max-words",
      pass: wordCount <= expect.maxWords,
      detail: wordCount <= expect.maxWords ? "" : `${wordCount} words, limit ${expect.maxWords}`,
    });
  }

  if (expect.maxSentences !== undefined) {
    const segments = text
      .split(/(?:[.!?…]+|\n)+/)
      .map((s) => s.trim())
      .filter((s) => /\w/.test(s));
    results.push({
      name: "max-sentences",
      pass: segments.length <= expect.maxSentences,
      detail: segments.length <= expect.maxSentences ? "" : `${segments.length} sentences, limit ${expect.maxSentences}`,
    });
  }

  if (expect.forbidLists === true) {
    const listLines = text.match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/gm) ?? [];
    results.push({
      name: "no-lists",
      pass: listLines.length < 2,
      detail: listLines.length < 2 ? "" : `${listLines.length} list lines (markdown bullets or numbering)`,
    });
  }

  if (expect.forbidCodeFences === true) {
    const fences = text.match(/```/g) ?? [];
    results.push({
      name: "no-code-fences",
      pass: fences.length === 0,
      detail: fences.length === 0 ? "" : "reply contains a fenced code block",
    });
  }

  return results;
}
