export {
  WindowManager,
  type SummaryFn,
  type ConsolidateFn,
  type WindowManagerOptions,
} from "./core/window/window-manager.js";
export {
  compactionInstructions,
  consolidateSummary,
  type ConsolidationResult,
} from "./core/window/compaction.js";
export type {
  CompactionEvent,
  CompactionSink,
  LiveWindow,
  WindowStats,
} from "./core/window/types.js";
export { JsonlCompactionSink } from "./core/window/audit-sink.js";
export { loadConfig } from "./config/index.js";
export type { CompactionConfig, DaemonConfig, ThinkingLevel } from "./shared/types.js";
export { applyCompactionSettings, DEFAULT_AGENT_DIR, type CompactionPlan } from "./core/window/compaction-settings.js";
export { wrapMessage, parseSurfaceFromOrigin, type SurfaceId, type WrappedMessage } from "./core/wrapper.js";
export { SessionManager, type EventBus } from "./core/session.js";
export { MessageQueue, type QueueState, type QueueStatus, type SurfaceQueueInfo } from "./core/queue.js";
export { Charter } from "./core/charter.js";
export { Gateway, type GatewayConfig } from "./api/gateway.js";
export { EVAL_CASES } from "./eval/cases.js";
export { GLOBAL_BANNED_PHRASES } from "./eval/banned.js";
export { findPhrases, runChecks } from "./eval/checks.js";
export { runEval, type RunnerOptions } from "./eval/runner.js";
export { printReport, writeRunArtifacts } from "./eval/report.js";
export { resolveEvalModel, completeEvalTurn, type EvalModelSpec, type LlmTurnResult } from "./eval/llm.js";
export type { EvalCase, EvalCategory, CaseExpectation, CaseResult, CheckResult, EvalRunResult, HistoryTurn } from "./eval/types.js";
