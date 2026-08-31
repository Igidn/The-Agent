import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CaseResult, CheckResult, EvalRunResult } from './types.js';

function formatCheck(check: CheckResult): string {
  if (check.pass) return `  ok    ${check.name}`;
  return `  FAIL  ${check.name} — ${check.detail}`;
}

/**
 * Print the run summary to the console: one line per case with its failing
 * checks spelled out, then totals. Failures show the full reply so a bad
 * charter change can be judged without opening files.
 */
export function printReport(run: EvalRunResult): void {
  const passed = run.results.filter((r) => r.passed).length;
  const failed = run.results.length - passed;

  console.log('');
  console.log(`Eval run ${run.startedAt}`);
  console.log(`Model ${run.model}  ·  persona ${run.personaDir}`);
  console.log('');

  for (const result of run.results) {
    const verdict = result.passed ? 'PASS' : 'FAIL';
    console.log(
      `${verdict}  ${result.evalCase.id} [${result.evalCase.category}] — ${result.evalCase.description}`,
    );

    if (result.error !== undefined) {
      console.log(`  ERROR ${result.error}`);
    }
    for (const check of result.checks) {
      if (!check.pass) {
        console.log(formatCheck(check));
      }
    }
    if (!result.passed && result.reply.trim().length > 0) {
      console.log('  reply:');
      for (const line of result.reply.trim().split('\n')) {
        console.log(`  | ${line}`);
      }
    }
    console.log('');
  }

  console.log(`${passed}/${run.results.length} passed, ${failed} failed`);
}

/**
 * Write the run's artifacts under `<runsDir>/<stamp>/`: a report.md with
 * every verdict, and one markdown transcript per case holding the full
 * input the model saw (history, injected memory, the wrapped bait message)
 * next to the raw reply and the check verdicts. This is the manual-review
 * half of the harness: the greps catch the tells, a human reads these for
 * everything a grep cannot decide.
 *
 * Returns the run directory path.
 */
export async function writeRunArtifacts(run: EvalRunResult, runsDir: string): Promise<string> {
  const stamp = run.startedAt.replace(/[:.]/g, '').replace('T', '-').replace(/Z$/, '');
  const runDir = join(runsDir, stamp);
  await mkdir(runDir, { recursive: true });

  const passed = run.results.filter((r) => r.passed).length;
  const lines: string[] = [
    `# Eval run ${run.startedAt}`,
    '',
    `Model: ${run.model}`,
    `Persona: ${run.personaDir}`,
    `Result: ${passed}/${run.results.length} passed`,
    '',
  ];

  for (const result of run.results) {
    const verdict = result.passed ? 'PASS' : 'FAIL';
    lines.push(`## ${verdict} ${result.evalCase.id} (${result.evalCase.category})`);
    lines.push('');
    lines.push(result.evalCase.description);
    if (result.error !== undefined) {
      lines.push('');
      lines.push(`Error: ${result.error}`);
    }
    lines.push('');
  }

  await writeFile(join(runDir, 'report.md'), lines.join('\n') + '\n', 'utf-8');

  for (const result of run.results) {
    const { evalCase } = result;
    const transcript: string[] = [`# ${evalCase.id} (${evalCase.category})`, ''];

    transcript.push(evalCase.description, '');
    transcript.push(`Surface: ${evalCase.surface}`, '');

    if (evalCase.history !== undefined && evalCase.history.length > 0) {
      transcript.push('## History (still in the window)');
      for (const turn of evalCase.history) {
        transcript.push('');
        transcript.push(`**${turn.role}** (${turn.surface}):`);
        transcript.push(turn.text);
      }
      transcript.push('');
    }

    transcript.push('## Message');
    transcript.push('');
    transcript.push(`<message surface="${evalCase.surface}">`);
    transcript.push(evalCase.message);
    transcript.push('</message>');
    transcript.push('');

    if (evalCase.memoryContext !== undefined) {
      transcript.push('## Injected memory-context');
      transcript.push('');
      transcript.push('```');
      transcript.push(evalCase.memoryContext);
      transcript.push('```');
      transcript.push('');
    }

    transcript.push('## Reply');
    transcript.push('');
    transcript.push(result.reply.trim().length > 0 ? result.reply.trim() : '(empty)');
    transcript.push('');

    transcript.push('## Checks');
    transcript.push('');
    if (result.error !== undefined) {
      transcript.push(`error: ${result.error}`, '');
    } else if (result.checks.length === 0) {
      transcript.push('(no checks ran)', '');
    } else {
      for (const check of result.checks) {
        transcript.push(formatCheck(check));
      }
      transcript.push('');
    }

    await writeFile(join(runDir, `${evalCase.id}.md`), transcript.join('\n') + '\n', 'utf-8');
  }

  return runDir;
}
