import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadConfig } from '../config/index.js';
import type { MemoryConfig } from '../shared/types.js';
import { Charter } from '../core/charter.js';
import { LocalEmbeddingProvider } from '../memory/embeddings.js';
import { SqliteMemoryStore } from '../memory/store.js';
import { printReport, writeRunArtifacts } from './report.js';
import { EVAL_CASES } from './cases.js';
import { resolveEvalModel, type EvalModelSpec } from './llm.js';
import { runEval } from './runner.js';
import { runCompactionEval } from './compaction.js';
import { hasSeedItems, runPrefetchForCase } from './memory-seeder.js';

/** Default eval model. Changing the default without re-running eval is a regression. */
const DEFAULT_EVAL_MODEL: EvalModelSpec = { provider: 'openrouter', id: 'z-ai/glm-5.3-flash' };

const USAGE = `Usage: npm run eval [-- <flag>...]

Flags:
  --model <provider/id>   Model to evaluate. Default: openrouter/${DEFAULT_EVAL_MODEL.id},
                          or MODEL_PROVIDER/MODEL_ID from the environment.
  --persona <dir>         Persona directory. Default: PERSONA_DIR or ./persona.
  --filter <substring>    Run only cases whose id or category contains this.
  --compaction            Run the compaction-quality suite (summary survival,
                          tool-spam drop, memory-context strip, consolidation)
                          instead of the persona cases. No persona needed.
  --memory                Run the persona eval with the real memory service
                          (embeddings + sqlite-vec + prefetch) instead of
                          hardcoded memory contexts. Seeds the store with
                          items matching each memory-bait case and runs the
                          real prefetch pipeline.
  --out <dir>             Where run artifacts are written. Default: .eval/runs.
  --concurrency <n>       Cases in flight at once. Default: 4.`;

/**
 * CLI entry for the eval harness. Returns the process exit code: 0 when
 * every case passed, 1 on eval failures, 2 when the run could not start
 * (bad flags, missing key, unresolvable model, empty persona).
 */
export async function evalMain(argv: readonly string[]): Promise<number> {
  const compactionRequested = argv.includes('--compaction');
  const memoryIntegrated = argv.includes('--memory');
  const args = argv.filter((a) => a !== '--compaction' && a !== '--memory');

  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (!arg.startsWith('--')) {
      console.error(`Unknown argument "${arg}"`);
      console.log(USAGE);
      return 2;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`Flag ${arg} needs a value`);
      console.log(USAGE);
      return 2;
    }
    flags.set(arg, value);
    i++;
  }

  {
    const envPath = resolve(process.cwd(), '.env');
    let raw: string;
    try {
      raw = readFileSync(envPath, 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // missing .env is fine
    }
  }

  const config = loadConfig();
  const modelSpec: EvalModelSpec = flags.has('--model')
    ? (() => {
        const value = flags.get('--model')!;
        const slash = value.indexOf('/');
        if (slash < 1 || slash === value.length - 1) {
          throw new Error(`--model expects <provider/id>, got "${value}"`);
        }
        return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
      })()
    : config.model !== undefined
      ? { provider: config.model.provider, id: config.model.id }
      : DEFAULT_EVAL_MODEL;

  if (compactionRequested) {
    console.log(`Running compaction-quality eval against ${modelSpec.provider}/${modelSpec.id}`);
    const result = await runCompactionEval(modelSpec);
    console.log(`\nCompaction eval: ${result.passed}/${result.total} cases passed`);
    return result.passed === result.total ? 0 : 1;
  }

  const personaDir = resolve(flags.get('--persona') ?? config.personaDir);

  const charter = new Charter(personaDir);
  await charter.load();
  if (charter.systemPrompt.trim().length === 0) {
    console.error(`No persona loaded from ${personaDir}. Eval without a charter tests nothing.`);
    return 2;
  }

  const filter = flags.get('--filter')?.toLowerCase();
  const selected =
    filter === undefined
      ? EVAL_CASES.map((c) => ({ ...c })) // Clone so we can safely mutate.
      : EVAL_CASES.filter((c) => c.id.includes(filter) || c.category.includes(filter)).map((c) => ({
          ...c,
        }));
  if (selected.length === 0) {
    console.error(`No cases match --filter "${filter}"`);
    return 2;
  }

  const concurrency = flags.has('--concurrency') ? Number(flags.get('--concurrency')) : 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    console.error('--concurrency must be an integer between 1 and 16');
    return 2;
  }

  const model = await resolveEvalModel(modelSpec).catch((err: Error) => {
    console.error(err.message);
    return undefined;
  });
  if (model === undefined) return 2;

  // ── Memory integration ──────────────────────────────────────────────
  let memoryStore: SqliteMemoryStore | undefined;
  let memoryEmbeddings: LocalEmbeddingProvider | undefined;
  let memoryDir: string | undefined;

  if (memoryIntegrated) {
    console.log('Memory integration enabled: using real embeddings + prefetch pipeline');
    memoryDir = await mkdtemp(join(tmpdir(), 'eval-memory-'));
    const dbPath = join(memoryDir, 'eval.db');
    memoryEmbeddings = new LocalEmbeddingProvider(
      config.memory?.embeddingModel ?? 'Xenova/bge-small-en-v1.5',
      config.memory?.embeddingDims ?? 384,
    );
    memoryStore = new SqliteMemoryStore(dbPath, memoryEmbeddings);

    // Seed the store with items that match the original hardcoded
    // memoryContext strings, then run real prefetch for each case.
    const prefetchCfg: MemoryConfig['prefetch'] = {
      topK: config.memory?.prefetch?.topK ?? 16,
      maxTokens: config.memory?.prefetch?.maxTokens ?? 300,
      strictCosine: config.memory?.prefetch?.strictCosine ?? 0.6,
      scoreThreshold: config.memory?.prefetch?.scoreThreshold ?? 0.4,
    };

    for (const c of selected) {
      if (!hasSeedItems(c.id)) continue;

      try {
        const context = await runPrefetchForCase(memoryStore, prefetchCfg, c);
        if (context !== null) {
          c.memoryContext = context;
          console.log(`  memory: ${c.id} prefetch returned ${context.length} chars`);
        } else {
          c.memoryContext = undefined;
          console.log(`  memory: ${c.id} prefetch returned null`);
        }
      } catch (err) {
        console.warn(`  memory: ${c.id} prefetch failed`, err);
      }
    }
  }

  console.log(`Evaluating ${selected.length} cases against ${modelSpec.provider}/${modelSpec.id}`);

  const run = await runEval({
    model,
    systemPrompt: charter.systemPrompt,
    cases: selected,
    concurrency,
    startedAt: new Date().toISOString(),
    personaDir,
  });

  printReport(run);

  const outDir = flags.get('--out') ?? resolve('.eval', 'runs');
  const runDir = await writeRunArtifacts(run, outDir);
  console.log(`Transcripts written to ${runDir}`);

  const exitCode = run.results.every((r) => r.passed) ? 0 : 1;

  // Cleanup memory resources.
  if (memoryStore !== undefined) {
    await memoryStore.close();
  }
  if (memoryDir !== undefined) {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {});
  }

  return exitCode;
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  evalMain(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('Eval: fatal error', err);
      process.exitCode = 2;
    });
}
