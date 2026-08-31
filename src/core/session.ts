import type { DaemonConfig } from "../config/index.js";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager as SdkSessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { Charter } from "./charter.js";
import {
  applyCompactionSettings,
  DEFAULT_AGENT_DIR,
  type CompactionPlan,
} from "./window/compaction-settings.js";

/** Typed event bus wrapper for session events. */
export type EventBus<T> = {
  on(channel: string, handler: (data: T) => void): () => void;
  emit(channel: string, data: T): void;
};

/**
 * Owns the single AgentSession and its ModelRuntime.
 *
 * start() boots the runtime, resolves or discovers a model, creates or resumes
 * the persistent session, and wires session events into an external event bus
 * so surfaces can stream deltas without touching the SDK directly.
 *
 * stop() disposes the session gracefully.
 */
export class SessionManager {
  /** Structured event bus that emits AgentSessionEvent values. */
  readonly onEvent: EventBus<AgentSessionEvent>;

  /** The active SDK session. Set after start() resolves. */
  session!: AgentSession;

  /** Model and auth runtime shared by every SDK call. */
  modelRuntime!: ModelRuntime;

  /** Compaction policy plan, set during start(). */
  compactionPlan!: CompactionPlan;

  private _sessionManager!: SdkSessionManager;
  private _disposed = false;

  constructor(private charter: Charter) {
    this.onEvent = createEventBus() as unknown as EventBus<AgentSessionEvent>;
  }

  /**
   * Boot the session infrastructure.
   *
   * 1. Initialises ModelRuntime (restores cached catalogs, optionally
   *    refreshes from the network).
   * 2. Resolves the configured model, or falls back to the first available
   *    model with valid auth.
   * 3. Opens the most recent session file for the working directory, or
   *    creates a fresh one if none exists.
   * 4. Creates the AgentSession with the resolved model and wires its
   *    event stream to the onEvent bus.
   */
  async start(config: DaemonConfig): Promise<void> {
    if (this._disposed) {
      throw new Error("SessionManager has been disposed");
    }

    this.modelRuntime = await ModelRuntime.create({
      allowModelNetwork: true,
      modelRefreshTimeoutMs: 15_000,
    });

    const resolvedModel = await this._resolveModel(config);
    const cwd = process.cwd();

    const settingsManager = SettingsManager.create(cwd, DEFAULT_AGENT_DIR);
    const compactionPlan = await applyCompactionSettings(
      config.compaction,
      resolvedModel,
      settingsManager,
    );
    this.compactionPlan = compactionPlan;
    console.log(
      `Compaction: auto-compact at ${compactionPlan.threshold} tokens, ` +
        `down to ${compactionPlan.target} ` +
        `(window ${compactionPlan.contextWindow})`,
    );

    this._sessionManager = SdkSessionManager.continueRecent(cwd);

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: DEFAULT_AGENT_DIR,
      systemPrompt: this.charter.systemPrompt || undefined,
    });

    const result = await createAgentSession({
      model: resolvedModel,
      modelRuntime: this.modelRuntime,
      sessionManager: this._sessionManager,
      settingsManager,
      resourceLoader,
      cwd,
      tools: ["read", "bash", "edit", "write"],
    });

    this.session = result.session;

    this.session.subscribe((event: AgentSessionEvent) => {
      this.onEvent.emit("session_event", event);
    });
  }

  /**
   * Graceful shutdown.
   *
   * Disposes the SDK session, which persists any remaining state and
   * tears down the agent runtime. Subsequent calls to start() are
   * allowed after stop().
   */
  async stop(): Promise<void> {
    this._disposed = false;
    if (this.session && !this.session.isIdle) {
      await this.session.abort();
    }
    if (this.session) {
      this.session.dispose();
    }
  }

  /**
   * Permanent disposal. After this the instance must not be reused.
   */
  dispose(): void {
    this._disposed = true;
    if (this.session) {
      this.session.dispose();
    }
  }


  prompt(text: string, options?: PromptOptions): Promise<void> {
    return this.session.prompt(text, options);
  }

  steer(text: string): Promise<void> {
    return this.session.steer(text);
  }

  followUp(text: string): Promise<void> {
    return this.session.followUp(text);
  }


  /**
   * Resolve the model from config or fall back to the first available
   * model that has valid authentication configured.
   */
  private async _resolveModel(
    config: DaemonConfig,
  ): Promise<Exclude<ReturnType<ModelRuntime["getModel"]>, undefined>> {
    if (config.model) {
      const configured = this.modelRuntime.getModel(
        config.model.provider,
        config.model.id,
      );
      if (configured) {
        return configured;
      }
      console.warn(
        `Model ${config.model.provider}/${config.model.id} not found; ` +
          `falling back to first available model`,
      );
    }

    const available = await this.modelRuntime.getAvailable();
    if (available.length === 0) {
      throw new Error(
        "No available models. Configure a provider API key " +
          "(e.g. ANTHROPIC_API_KEY) and restart.",
      );
    }

    return available[0];
  }
}