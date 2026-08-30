# The Agent

A personal agent that talks like a friend, one continuous session across every surface.

## Eval

Charter changes ship with eval output. The suite baits the failure families the charter is supposed to prevent (sycophancy, memory-bait, thread-drift, verbosity), greps the replies for banned phrases and per-case expectations, and writes transcripts for manual review.

```bash
npm run eval
```

Needs `OPENROUTER_API_KEY` in the environment or in `.env`. Defaults to `openrouter/z-ai/glm-5.3-flash`; override with `--model <provider/id>`, `--filter <substring>`, `--persona <dir>`, `--out <dir>`, or `--concurrency <n>` (see `--help`). Exit code is non-zero when any case fails, so it fits CI. Artifacts land in `.eval/runs/<timestamp>/` (gitignored): a `report.md` plus one transcript per case with the exact input the model saw.

Cases live in `src/eval/cases.ts`, the global banned-phrase list in `src/eval/banned.ts`. The check engine and bait matching have unit tests: `npm test`.
