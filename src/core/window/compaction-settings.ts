import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { CompactionSettings } from '@earendil-works/pi-coding-agent';

import type { CompactionConfig } from '../../shared/types.js';

/**
 * The pi config directory the daemon shares with its SDK sessions.
 *
 * The SDK defaults to this path when its own SettingsManager is created, so
 * the daemon must write against the same directory or its policy would live
 * in a file the session never reads.
 */
export const DEFAULT_AGENT_DIR = join(homedir(), '.pi', 'agent');

/**
 * The daemon's compaction policy in both vocabularies.
 *
 * threshold/target are the design's absolute token counts; reserveTokens /
 * keepRecentTokens are the SDK-relative form (margin below the model's
 * contextWindow, and recent tokens the cut point retains) that the session's
 * auto-compaction trigger actually reads. contextWindow is the model the
 * mapping was computed against, so callers can tell stale plans apart.
 */
export interface CompactionPlan {
  /** Design term: trigger when the live window reaches this many tokens. */
  threshold: number;
  /** Design term: keep this many recent tokens after an epoch. */
  target: number;
  /** SDK term: margin below contextWindow at which the trigger fires. */
  reserveTokens: number;
  /** SDK term: recent tokens the cut point keeps. */
  keepRecentTokens: number;
  /** Context window the mapping was computed against. */
  contextWindow: number;
}

/**
 * Persist the compaction policy into the settings manager shared with the
 * SDK session, then return the mapped plan.
 *
 * The SDK's public SettingsManager API only exposes the `enabled` flag as a
 * persisted setter; there is no public write for reserveTokens /
 * keepRecentTokens. So the token fields are merged into the agentDir
 * settings.json by hand (the same JSON object shape the SDK loads), the
 * manager is reloaded so its in-memory view matches the file, and the
 * enabled flag rides through the manager's own persisted path, whose nested
 * merge preserves the token fields already on disk.
 *
 * Must run before createAgentSession() so the session loads the written
 * values. A failed write degrades to the SDK's built-in defaults and is
 * reported, never fatal.
 */
export async function applyCompactionSettings(
  policy: CompactionConfig,
  model: { contextWindow: number },
  settingsManager: SettingsManager,
  agentDir: string = DEFAULT_AGENT_DIR,
): Promise<CompactionPlan> {
  const reserveTokens = model.contextWindow - policy.compactAtTokens;
  const plan: CompactionPlan = {
    threshold: policy.compactAtTokens,
    target: policy.compactToTokens,
    reserveTokens: reserveTokens > 0 ? reserveTokens : 0,
    keepRecentTokens: policy.compactToTokens,
    contextWindow: model.contextWindow,
  };

  if (model.contextWindow <= policy.compactAtTokens) {
    console.warn(
      `Compaction: model window ${model.contextWindow} is below ` +
        `COMPACT_AT_TOKENS (${policy.compactAtTokens}); the trigger will ` +
        `only fire when the context overflows the window`,
    );
  }

  const block: CompactionSettings = {
    enabled: true,
    reserveTokens: plan.reserveTokens,
    keepRecentTokens: plan.keepRecentTokens,
  };

  try {
    const settingsPath = join(agentDir, 'settings.json');

    let current: string | undefined;
    try {
      current = await readFile(settingsPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const file: Record<string, unknown> =
      current === undefined
        ? {}
        : (() => {
            try {
              return JSON.parse(current.replace(/^\uFEFF/, '')) as Record<string, unknown>;
            } catch {
              throw new Error('settings.json is not valid JSON; leaving it untouched');
            }
          })();

    file.compaction = block;

    await mkdir(agentDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify(file, null, 2));

    await settingsManager.reload();
    settingsManager.setCompactionEnabled(true);
    await settingsManager.flush();
  } catch (err) {
    console.warn('Compaction: settings write failed; falling back to SDK defaults', err);
  }

  for (const { scope, error } of settingsManager.drainErrors()) {
    console.warn(`Compaction: ${scope} settings error: ${error.message}`);
  }

  return plan;
}
