import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  applyCompactionSettings,
  DEFAULT_AGENT_DIR,
  type CompactionPlan,
} from "./compaction-settings.js";
import type { CompactionConfig } from "../../config/index.js";

/** The design's default policy: cover the doc's open question config-side. */
const DESIGN_POLICY: CompactionConfig = {
  compactAtTokens: 80000,
  compactToTokens: 40000,
};

/** A 200k-window model, the design's assumed case. */
const WINDOW_200K = { contextWindow: 200000 };

/** Temp dirs per test; everything here is throwaway. */
async function withTempDirs(
  fn: (cwd: string, agentDir: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "compaction-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "compaction-agent-"));
  try {
    await fn(cwd, agentDir);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
}

async function readSettingsFile(agentDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(agentDir, "settings.json"), "utf-8");
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
}

test("mapping contract: 80k→40k against a 200k window is reserve 120k, keep 40k", async () => {
  await withTempDirs(async (cwd, agentDir) => {
    const manager = SettingsManager.create(cwd, agentDir);
    const plan = await applyCompactionSettings(
      DESIGN_POLICY,
      WINDOW_200K,
      manager,
      agentDir,
    );

    assert.deepEqual(plan, {
      threshold: 80000,
      target: 40000,
      reserveTokens: 120000,
      keepRecentTokens: 40000,
      contextWindow: 200000,
    });
  });
});

test("the settings manager the session will read sees the mapped values", async () => {
  await withTempDirs(async (cwd, agentDir) => {
    const manager = SettingsManager.create(cwd, agentDir);
    await applyCompactionSettings(DESIGN_POLICY, WINDOW_200K, manager, agentDir);

    const effective = manager.getCompactionSettings();
    assert.equal(effective.enabled, true);
    assert.equal(effective.reserveTokens, 120000);
    assert.equal(effective.keepRecentTokens, 40000);
  });
});

test("the agentDir settings.json carries the full compaction block", async () => {
  await withTempDirs(async (cwd, agentDir) => {
    const manager = SettingsManager.create(cwd, agentDir);
    await applyCompactionSettings(DESIGN_POLICY, WINDOW_200K, manager, agentDir);

    const file = await readSettingsFile(agentDir);
    assert.deepEqual(file.compaction, {
      enabled: true,
      reserveTokens: 120000,
      keepRecentTokens: 40000,
    });
  });
});

test("pre-existing settings in the file survive the write", async () => {
  await withTempDirs(async (cwd, agentDir) => {
    // A settings file the user or a previous run already populated.
    const preSeed = JSON.stringify({ theme: "dark", defaultModel: "x/y" }, null, 2);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(agentDir, "settings.json"), preSeed);

    const manager = SettingsManager.create(cwd, agentDir);
    await applyCompactionSettings(DESIGN_POLICY, WINDOW_200K, manager, agentDir);

    const file = await readSettingsFile(agentDir);
    assert.equal(file.theme, "dark");
    assert.equal(file.defaultModel, "x/y");
    assert.deepEqual(file.compaction, {
      enabled: true,
      reserveTokens: 120000,
      keepRecentTokens: 40000,
    });
  });
});

test("a window below the threshold clamps reserveTokens to zero", async () => {
  await withTempDirs(async (cwd, agentDir) => {
    const manager = SettingsManager.create(cwd, agentDir);
    const plan: CompactionPlan = await applyCompactionSettings(
      DESIGN_POLICY,
      { contextWindow: 60000 },
      manager,
      agentDir,
    );

    assert.equal(plan.reserveTokens, 0);
    const file = await readSettingsFile(agentDir);
    const block = file.compaction as { reserveTokens: number };
    assert.equal(block.reserveTokens, 0);
  });
});

test("a missing settings file is created with the compaction block alone", async () => {
  await withTempDirs(async (cwd, agentDir) => {
    const manager = SettingsManager.create(cwd, agentDir);
    await applyCompactionSettings(DESIGN_POLICY, WINDOW_200K, manager, agentDir);

    const file = await readSettingsFile(agentDir);
    assert.deepEqual(Object.keys(file), ["compaction"]);
  });
});

test("a fresh manager over the same dirs reads the persisted values", async () => {
  await withTempDirs(async (cwd, agentDir) => {
    const writer = SettingsManager.create(cwd, agentDir);
    await applyCompactionSettings(DESIGN_POLICY, WINDOW_200K, writer, agentDir);

    // The SDK session creates its own manager when none is passed; it must
    // see the same policy from disk.
    const fresh = SettingsManager.create(cwd, agentDir);
    assert.deepEqual(fresh.getCompactionSettings(), {
      enabled: true,
      reserveTokens: 120000,
      keepRecentTokens: 40000,
    });
  });
});

test("a corrupt settings file is left untouched and apply degrades to defaults", async () => {
  await withTempDirs(async (cwd, agentDir) => {
    const corrupt = "{ this is not json";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(agentDir, "settings.json"), corrupt);

    const manager = SettingsManager.create(cwd, agentDir);
    const plan = await applyCompactionSettings(
      DESIGN_POLICY,
      WINDOW_200K,
      manager,
      agentDir,
    );

    const rawAfter = await readFile(join(agentDir, "settings.json"), "utf-8");
    assert.equal(rawAfter, corrupt, "corrupt file must not be rewritten");
    // The manager's read path falls back to SDK defaults.
    assert.equal(manager.getCompactionSettings().reserveTokens, 16384);
    // The plan still reports the intended mapping.
    assert.equal(plan.reserveTokens, 120000);
  });
});

test("DEFAULT_AGENT_DIR points at the daemon's shared pi config directory", () => {
  assert.match(DEFAULT_AGENT_DIR, /\.pi[/\\]agent$/);
});