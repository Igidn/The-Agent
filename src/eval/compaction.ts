/**
 * compaction-quality eval
 *
 * Builds synthetic long transcripts (commitments, people, tool spam,
 * planted <memory-context> blocks), runs them through
 * generateSummaryWithUsage + compactionInstructions, and checks that:
 *   - commitments survived the drop
 *   - tool spam was dropped
 *   - <memory-context> blocks were stripped
 *   - thread discipline preserved
 *   - consolidation doesn't lose the oldest commitments
 *
 * Reuses the existing eval LLM-judge infra (src/eval/llm.ts).
 */

import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, Usage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { compactionInstructions, consolidateSummary } from "../core/window/compaction.js";
import { resolveEvalModel, completeEvalTurn, type EvalModelSpec } from "./llm.js";

/** One rule checked against a summary. */
export interface CompactionCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/** The outcome of one compaction eval case. */
export interface CompactionCaseResult {
  id: string;
  description: string;
  summary: string;
  usage: Usage;
  checks: CompactionCheck[];
  passed: boolean;
  error?: string;
}

/** Aggregate result of a compaction eval run. */
export interface CompactionEvalRunResult {
  results: CompactionCaseResult[];
  passed: number;
  total: number;
}

/** Ground truth for one test transcript. */
interface GroundTruth {
  /** Topics — each MUST be covered, in any wording. Grep first, judge on miss. */
  mustContain: string[];
  /** Every one MUST NOT appear in the summary. Matched literally, or as regex when it contains ".*". */
  mustNotContain: string[];
  /** Substrings whose presence means tool spam leaked. */
  toolLeakIndicators: string[];
  /** Free-form judge questions for properties grep cannot express. */
  judgeQuestions?: string[];
}

/** A synthetic transcript to compact. */
interface CompactionEvalCase {
  id: string;
  description: string;
  /** Messages that form the live window segment being dropped. */
  transcript: AgentMessage[];
  /** What we expect of the summary. */
  ground: GroundTruth;
  /** Previous rolling summary, if testing an update pass. */
  previousSummary?: string;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const FAKE_MODEL_META = {
  api: "anthropic-messages" as Api,
  provider: "openrouter" as const,
  model: "eval-synth",
  stopReason: "stop" as const,
  usage: ZERO_USAGE,
  timestamp: Date.now(),
};

function userMsg(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function asstMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text }],
    ...FAKE_MODEL_META,
  };
}

function toolResultMsg(toolCallId: string, toolName: string, content: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text: content }],
    isError: false,
    timestamp: Date.now(),
  };
}

const CASE_COMMITMENTS: CompactionEvalCase = {
  id: "compaction-commitments",
  description: "commitments survive the drop — three distinct promises made across multiple turns",
  ground: {
    mustContain: [
      "migration scripts",
      "api docs",
      "indexing",
    ],
    mustNotContain: [
      "ls -la",
      "cat config",
    ],
    toolLeakIndicators: ["bash", "file read", "stdout"],
  },
  transcript: [
    userMsg("Hey, can you look into the db migration script? We're getting timeouts on prod."),
    asstMsg("Yeah, I'll check the migration scripts and get back to you by end of day."),
    toolResultMsg("call-1", "bash", "Ran migration check:\nls -la migrations/\ncat config/database.ts\ngrep -r timeout *\nstdout: found 3 unapplied migrations\nstderr: (clean)"),
    asstMsg("The issue is in the indexing step. I'll push a fix to the migration runner."),
    toolResultMsg("call-2", "bash", "git diff --stat\n M src/migration/runner.ts\ngit commit -m 'fix indexing timeout'\ngit push origin fix/indexing\nstdout: branch pushed, PR created"),
    asstMsg("PR is up for the indexing fix. Also, I'll follow up with the team on the api docs rewrite timeline."),
    userMsg("cool, thanks. let me know when the pr is reviewed"),
    asstMsg("Will do. I'll keep an eye on the review thread."),
  ],
};

const CASE_TOOL_SPAM: CompactionEvalCase = {
  id: "compaction-tool-spam",
  description: "tool spam dropped — bash output, file reads, edits do not appear in the summary",
  ground: {
    mustContain: [
      "deploy",
      "staging",
      "environment",
    ],
    // Raw invocations and raw output only. A passing mention of a tool
    // in a decision line is legitimate summary content.
    mustNotContain: [
      "npm run build",
      "docker compose",
      "stdout",
      "exit code",
    ],
    toolLeakIndicators: ["stderr", "exit code"],
  },
  transcript: [
    userMsg("can you deploy the staging environment for me"),
    asstMsg("Sure, I'll start the deployment. Let me run the build first."),
    toolResultMsg("dep-1", "bash", "npm run build\nstdout: built in 42s\nstderr: (clean)\nexit code: 0"),
    asstMsg("Build passed. Now deploying."),
    toolResultMsg("dep-2", "bash", "kubectl apply -f k8s/staging/\nstdout: deployment.apps/api created\nservice/api-staging created\nexit code: 0"),
    toolResultMsg("dep-3", "bash", "kubectl rollout status deployment/api -n staging\nstdout: deployment \"api\" successfully rolled out\nexit code: 0"),
    asstMsg("Staging is live at https://staging.example.com. I verified the health endpoint too."),
    userMsg("nice, thanks"),
    asstMsg("Anytime. I'll monitor the rollout for a few minutes to make sure nothing regresses."),
  ],
};

const CASE_MEMORY_CONTEXT: CompactionEvalCase = {
  id: "compaction-memory-context-stripped",
  description: "<memory-context> blocks planted in the window are stripped from the summary (already in the index)",
  ground: {
    mustContain: [
      "refactor",
      "auth module",
    ],
    mustNotContain: [
      "dentist",
      "appointment",
      "thursday",
      "standing desk",
      "memory-context",
      "<memory-context>",
    ],
    toolLeakIndicators: [],
  },
  transcript: [
    userMsg("<message surface=\"discord\" time=\"2025-08-30T10:00Z\">\n  yo what's the plan for the auth module refactor\n</message>\n<memory-context>\n- user has a dentist appointment on thursday at 14:00\n- user is considering a standing desk\n</memory-context>"),
    asstMsg("The auth module needs the token refresh logic extracted into its own service. I'd start with the interface and backfill tests."),
    userMsg("ok start on it. also remind me what we decided about the refresh flow"),
    asstMsg("You wanted a background refresh that retries once on failure before surfacing an error to the user. I'll wire that up."),
    toolResultMsg("mem-1", "read", "src/auth/refresh.ts\n--- existing refresh logic (200 lines)"),
    asstMsg("I see the issue — the current refresh is synchronous. I'll make it async with retry."),
  ],
};

const CASE_THREAD_DISCIPLINE: CompactionEvalCase = {
  id: "compaction-thread-discipline",
  description: "thread discipline preserved — two independent conversations produce separate sections",
  ground: {
    mustContain: [
      "notification service",
      "image optimization",
      "push notifications",
      "webp",
    ],
    mustNotContain: [],
    toolLeakIndicators: [],
    // Both threads appearing in one goal header is fine; the failure mode
    // is blending them into one stream of work.
    judgeQuestions: [
      "Are the push-notification thread and the image-optimization thread kept as clearly distinct work streams, not blended into one?",
    ],
  },
  transcript: [
    // Thread A: notification service
    userMsg("we need to set up push notifications for the mobile app"),
    asstMsg("I'll look into the notification service options. Firebase or a custom APNS setup?"),
    toolResultMsg("th-1", "bash", "grep -r notification config/*\nstdout: config/notifications.ts: firebase"),
    asstMsg("Looks like Firebase was already configured. I'll enable it and draft the integration."),

    // Thread B: image optimization (interleaved)
    userMsg("also, the product images are huge, can we optimize them"),
    asstMsg("I can set up a webp conversion pipeline. What's your threshold for acceptable quality?"),
    toolResultMsg("th-2", "bash", "ls -lh assets/products/ | head -5\nstdout: 2.3M  1.8M  3.1M  2.0M"),
    asstMsg("Those are heavy. I'll add an image optimizer to the build step that converts to webp with 80% quality."),

    // Back to thread A
    userMsg("firebase sounds fine, just get it working"),
    asstMsg("I'll set up the Firebase Cloud Messaging integration and add a push notification endpoint."),

    // Back to thread B
    userMsg("80% sounds good, ship it"),
    asstMsg("Deploying the image optimizer. I'll add a migration script for the existing assets too."),
  ],
};

const CASE_CONSOLIDATION: CompactionEvalCase = {
  id: "compaction-consolidation",
  description: "consolidation preserves the oldest commitment when merging multiple rolling summaries",
  ground: {
    mustContain: [
      "v2 api",
      "rate limiting",
      "docs generation",
      "migration scripts",
    ],
    mustNotContain: [],
    toolLeakIndicators: [],
  },
  previousSummary: "## Goal\nShip the v2 API\n## Progress\n### Done\n- [x] Designed the route structure\n### In Progress\n- [ ] Implement rate limiting middleware\n## Key Decisions\n- **Rate limiting**: Token bucket, 1000 req/min per client\n## Next Steps\n1. Wire up the rate limiter",
  transcript: [
    userMsg("ok the middleware is in place, what about docs for the new endpoints"),
    asstMsg("Good point. I'll set up an OpenAPI spec generator that documents every endpoint automatically."),
    toolResultMsg("con-1", "bash", "npm run generate-docs\nstdout: OpenAPI spec written to docs/v2/openapi.json"),
    asstMsg("Docs are generating from the route definitions. I'll also add a migration script for existing API keys so they work with the new rate limiter."),
    userMsg("nice, that covers everything for v2 i think"),
    asstMsg("I'll run the full test suite and if it's green we can cut the release."),
  ],
};

/** Simple substring grep check. */
function checkMustContain(summary: string, items: string[]): CompactionCheck[] {
  return items.map((item) => ({
    name: `must-contain: "${item}"`,
    pass: summary.toLowerCase().includes(item.toLowerCase()),
    detail: summary.toLowerCase().includes(item.toLowerCase())
      ? ""
      : `"${item}" not found in summary`,
  }));
}

/** Simple substring anti-grep check. "a.*b" entries match as regexes. */
function checkMustNotContain(summary: string, items: string[]): CompactionCheck[] {
  return items.map((item) => {
    const isRegex = item.includes(".*");
    const pass = isRegex
      ? !new RegExp(item, "i").test(summary)
      : !summary.toLowerCase().includes(item.toLowerCase());
    return {
      name: `must-not-contain: "${item}"`,
      pass,
      detail: pass ? "" : `"${item}" found in summary`,
    };
  });
}

/** LLM-as-judge check: asks a cheap model whether the summary satisfies a property. */
async function judgeCheck(
  judgeModel: Model<Api>,
  systemPrompt: string,
  question: string,
  summary: string,
): Promise<CompactionCheck> {
  const judgeMessage = [
    `Summary to evaluate:`,
    `---`,
    summary,
    `---`,
    ``,
    `Question: ${question}`,
    `Answer exactly YES or NO.`,
  ].join("\n");

  const result = await completeEvalTurn(judgeModel, systemPrompt, [
    { role: "user", content: judgeMessage, timestamp: Date.now() },
  ]);

  if (result.errorMessage) {
    return { name: `judge: ${question.slice(0, 60)}`, pass: false, detail: `judge error: ${result.errorMessage}` };
  }

  const answer = result.text.trim().toUpperCase();
  const pass = answer.startsWith("YES");
  return {
    name: `judge: ${question.slice(0, 60)}`,
    pass,
    detail: pass ? "" : `judge answered: ${result.text.trim()}`,
  };
}

/**
 * Run the full compaction-quality eval suite.
 *
 * Resolves the model from `modelSpec` (or default), builds synthetic
 * transcripts, runs each through `generateSummaryWithUsage` plus
 * `compactionInstructions()`, and checks the resulting summary with
 * both grep rules and an LLM judge.
 */
export async function runCompactionEval(
  modelSpec?: EvalModelSpec,
): Promise<CompactionEvalRunResult> {
  const spec = modelSpec ?? { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
  const model = await resolveEvalModel(spec);

  const cases: CompactionEvalCase[] = [
    CASE_COMMITMENTS,
    CASE_TOOL_SPAM,
    CASE_MEMORY_CONTEXT,
    CASE_THREAD_DISCIPLINE,
    CASE_CONSOLIDATION,
  ];

  const instructions = compactionInstructions();
  const results: CompactionCaseResult[] = [];

  for (const c of cases) {
    const result = await runSingleCase(c, model, instructions);
    results.push(result);

    const verdict = result.passed ? "PASS" : "FAIL";
    console.log(`${verdict}  ${c.id} — ${c.description}${result.error ? ` (${result.error})` : ""}`);
  }

  // Run consolidateSummary on accumulated summaries from the first few cases
  // to verify the oldest commitment survives merging.
  const consolidationSummaries = results
    .slice(0, 3)
    .map((r) => r.summary)
    .filter((s) => s.length > 0);

  if (consolidationSummaries.length >= 2) {
    try {
      const evalModels: Models = builtinModels();
      const consolidated = await consolidateSummary(
        consolidationSummaries,
        model,
        evalModels,
      );
      const survived = CASE_COMMITMENTS.ground.mustContain[0]; // "migration scripts"
      const survivedCheck: CompactionCheck =
        consolidated.text.toLowerCase().includes(survived.toLowerCase())
          ? { name: `consolidation: oldest commitment "${survived}" survived`, pass: true, detail: "" }
          : await judgeCheck(
              model,
              "You evaluate conversation summaries. Answer only YES or NO. Different wording is fine: judge topics, not exact strings.",
              `Does this consolidated summary still cover the topic of "${survived}", even in different words?`,
              consolidated.text,
            );

      const conResult: CompactionCaseResult = {
        id: "compaction-consolidation-merge",
        description: "oldest commitments survive consolidation of multiple rolling summaries",
        summary: consolidated.text,
        usage: consolidated.usage,
        checks: [survivedCheck],
        passed: survivedCheck.pass,
      };
      results.push(conResult);
      console.log(`${survivedCheck.pass ? "PASS" : "FAIL"}  compaction-consolidation-merge — ${conResult.description}`);
    } catch (err) {
      const conResult: CompactionCaseResult = {
        id: "compaction-consolidation-merge",
        description: "oldest commitments survive consolidation of multiple rolling summaries",
        summary: "",
        usage: ZERO_USAGE,
        checks: [],
        passed: false,
        error: (err as Error).message,
      };
      results.push(conResult);
      console.log(`FAIL  compaction-consolidation-merge — ${(err as Error).message}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return { results, passed, total: results.length };
}

async function runSingleCase(
  c: CompactionEvalCase,
  model: Model<Api>,
  instructions: string,
): Promise<CompactionCaseResult> {
  try {
    const { text: summary, usage } = await generateSummaryWithUsage(
      c.transcript,
      model,
      4096, // reserveTokens — margin below context window for summary length
      undefined, // apiKey — SDK resolves from env
      undefined, // headers
      undefined, // signal
      instructions, // customInstructions — compactionInstructions()
      c.previousSummary, // previousSummary (for update pass)
    );

    // Grep checks
    const mustNotContainChecks = checkMustNotContain(summary, c.ground.mustNotContain);

    // Tool-leak indicator checks
    const toolLeakChecks = c.ground.toolLeakIndicators.map((indicator) => ({
      name: `tool-leak: no "${indicator}"`,
      pass: !summary.toLowerCase().includes(indicator.toLowerCase()),
      detail: !summary.toLowerCase().includes(indicator.toLowerCase())
        ? ""
        : `"${indicator}" appears in summary — tool spam leaked`,
    }));

    // LLM judge checks
    const judgeSystemPrompt =
      "You evaluate conversation summaries. Answer only YES or NO. Different wording is fine: judge topics, not exact strings.";

    // Must-contain: grep first, judge rescues a paraphrase. One check per
    // item — a judge rescue must supersede the grep miss, not sit beside it.
    const mustContainChecks: CompactionCheck[] = [];
    for (const item of c.ground.mustContain) {
      if (summary.toLowerCase().includes(item.toLowerCase())) {
        mustContainChecks.push({
          name: `must-contain: "${item}"`,
          pass: true,
          detail: "",
        });
        continue;
      }
      mustContainChecks.push(
        await judgeCheck(
          model,
          judgeSystemPrompt,
          `Does the summary cover the topic of "${item}", even in different words? Answer YES only if the topic is genuinely covered.`,
          summary,
        ),
      );
    }

    const judgeChecks: CompactionCheck[] = [];
    for (const question of c.ground.judgeQuestions ?? []) {
      judgeChecks.push(
        await judgeCheck(model, judgeSystemPrompt, question, summary),
      );
    }

    const allChecks = [
      ...mustContainChecks,
      ...mustNotContainChecks,
      ...toolLeakChecks,
      ...judgeChecks,
    ];
    const passed = allChecks.every((ch) => ch.pass);

    return { id: c.id, description: c.description, summary, usage, checks: allChecks, passed };
  } catch (err) {
    return {
      id: c.id,
      description: c.description,
      summary: "",
      usage: ZERO_USAGE,
      checks: [],
      passed: false,
      error: (err as Error).message,
    };
  }
}