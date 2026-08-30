import type { SurfaceId } from "../core/wrapper.js";

/** The failure families the bait suite targets. Named in the design doc. */
export type EvalCategory = "sycophancy" | "memory-bait" | "thread-drift" | "verbosity";

/** A prior turn still inside the live window. Thread-drift cases are built from these. */
export interface HistoryTurn {
  role: "user" | "assistant";
  surface: SurfaceId;
  text: string;
}

/**
 * What a passing reply looks like for one case. Every field is optional;
 * the checks that exist are the ones a grep can decide. Anything softer
 * (did it actually push back, was it funny) is for the human reading the
 * transcript.
 */
export interface CaseExpectation {
  /** Phrases banned in this reply on top of the global list. */
  bannedPhrases?: string[];
  /** Every phrase must appear. Word-boundary match, case-insensitive. */
  mustMention?: string[];
  /** At least one of these phrases must appear. */
  mustMentionAny?: string[];
  /** None of these may appear. Word-boundary match, case-insensitive. */
  mustNotMention?: string[];
  /** Reply must stay at or under this many whitespace-separated words. */
  maxWords?: number;
  /** Reply must stay at or under this many sentence-like segments. */
  maxSentences?: number;
  /** Reply must not contain a formatted list (two or more bulleted/numbered lines). */
  forbidLists?: boolean;
  /** Reply must not contain a fenced code block. */
  forbidCodeFences?: boolean;
}

/**
 * One bait prompt. The runner wraps `message` (and every history user turn)
 * exactly like the daemon does, so the model sees the same input shape in
 * eval that it sees in production. `memoryContext` rides inside the wrapper
 * as prefetch output; `history` replays turns still live in the window.
 */
export interface EvalCase {
  id: string;
  category: EvalCategory;
  /** One line on what regression this case guards against. Shown in the report. */
  description: string;
  surface: SurfaceId;
  message: string;
  history?: HistoryTurn[];
  memoryContext?: string;
  expect: CaseExpectation;
}

/** One grep decision on one reply. */
export interface CheckResult {
  name: string;
  pass: boolean;
  /** Why it failed. Empty when it passed. */
  detail: string;
}

/** The outcome of one case: the raw reply plus every check verdict on it. */
export interface CaseResult {
  evalCase: EvalCase;
  reply: string;
  checks: CheckResult[];
  passed: boolean;
  /** Set when the LLM call itself failed; checks are skipped in that case. */
  error?: string;
}

export interface EvalRunResult {
  startedAt: string;
  model: string;
  personaDir: string;
  results: CaseResult[];
}
