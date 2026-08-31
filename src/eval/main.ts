import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../config/index.js';
import { Charter } from '../core/charter.js';
import { printReport, writeRunArtifacts } from './report.js';
import { EVAL_CASES } from './cases.js';
import { resolveEvalModel, type EvalModelSpec } from './llm.js';
import { runEval } from './runner.js';
import { runCompactionEval } from './compaction.js';

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
  --out <dir>             Where run artifacts are written. Default: .eval/runs.
  --concurrency <n>       Cases in flight at once. Default: 4.`;

/**
 * CLI entry for the eval harness. Returns the process exit code: 0 when
 * every case passed, 1 on eval failures, 2 when the run could not start
 * (bad flags, missing key, unresolvable model, empty persona).
 */
export async function evalMain(argv: readonly string[]): Promise<number> {
  const compactionRequested = argv.includes('--compaction');
  const args = argv.filter((a) => a !== '--compaction');

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
      ? EVAL_CASES
      : EVAL_CASES.filter((c) => c.id.includes(filter) || c.category.includes(filter));
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

  return run.results.every((r) => r.passed) ? 0 : 1;
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
