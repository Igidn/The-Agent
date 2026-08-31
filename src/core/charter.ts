import { readFile, watch } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";

/**
 * Owns the persona system prompt composed from `charter.md` and
 * `few-shots.md` in the persona directory.
 *
 * Loads both files on demand, concatenates them (charter first, then
 * few-shots), and exposes the result as `systemPrompt`.  Can hot-reload
 * by watching the directory for changes.
 *
 * Error handling keeps the previous version intact when a reload fails
 * so the running session never loses its persona mid-turn.
 */
export class Charter {
  private _systemPrompt = "";
  private _loaded = false;
  private _abortController: AbortController | null = null;

  /**
   * @param personaDir  Path to the directory holding charter.md and
   *                    few-shots.md.  Relative paths are resolved from
   *                    `process.cwd()`.
   */
  constructor(private personaDir: string) {}

  /** Composed system prompt (charter first, then few-shots, then profile placeholder). */
  get systemPrompt(): string {
    return this._systemPrompt;
  }

  /**
   * Replace the `<!-- profile -->` placeholder in the system prompt with a
   * profile section block.
   *
   * The first call replaces the bare placeholder.  Subsequent calls replace
   * the entire `<!-- profile -->…<!-- /profile -->` block, so the profile
   * section can be updated without accumulating stale entries.
   *
   * May only be called from a `windowManager.onBoundary` callback.  Profile
   * changes at compaction boundaries are the single sanctioned system-prompt
   * mutation point (the cache is already dead from the summary rewrite).
   */
  setProfileSection(text: string): void {
    const block = `<!-- profile -->\n${text}\n<!-- /profile -->`;
    const blockPattern = /<!-- profile -->[\s\S]*?<!-- \/profile -->/;

    if (blockPattern.test(this._systemPrompt)) {
      this._systemPrompt = this._systemPrompt.replace(blockPattern, block);
    } else if (this._systemPrompt.includes("<!-- profile -->")) {
      this._systemPrompt = this._systemPrompt.replace("<!-- profile -->", block);
    }
    // No placeholder — nothing to do.  The prompt was not composed with one.
  }

  /**
   * Read `charter.md` and `few-shots.md` from the persona directory and
   * compose them into `systemPrompt`.  Missing files are treated as empty.
   *
   * On failure, logs the error and keeps the previous `systemPrompt`
   * if one existed.
   */
  async load(): Promise<void> {
    try {
      const dir = resolve(this.personaDir);
      const [charter, fewShots] = await Promise.all([
        this._readOptional(join(dir, "charter.md")),
        this._readOptional(join(dir, "few-shots.md")),
      ]);
      this._systemPrompt = this._compose(charter, fewShots);
      this._loaded = true;
    } catch (err) {
      console.error("Charter: load failed", err);
      if (!this._loaded) {
        this._systemPrompt = "";
      }
    }
  }

  /**
   * Start watching the persona directory for changes to `charter.md`
   * or `few-shots.md`.  On change, reloads and calls `callback` if
   * provided.
   *
   * Safe to call multiple times – only one watcher runs.  If the
   * directory does not exist, a warning is logged and the watcher is
   * skipped (no error thrown).
   */
  watch(callback?: () => void): void {
    if (this._abortController) return;

    const ac = new AbortController();
    this._abortController = ac;

    const dir = resolve(this.personaDir);
    this._runWatcher(dir, ac.signal, callback).catch((err) => {
      if ((err as Error).name !== "AbortError") {
        console.error("Charter: watcher error", err);
      }
    });
  }

  /** Stop watching.  After this, `watch()` can be called again. */
  unwatch(): void {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }


  private async _runWatcher(
    dir: string,
    signal: AbortSignal,
    callback?: () => void,
  ): Promise<void> {
    try {
      await stat(dir);
    } catch {
      console.warn(
        `Charter: persona directory "${dir}" not found; watching skipped`,
      );
      return;
    }

    try {
      const watcher = watch(dir, { signal, recursive: false });
      for await (const event of watcher) {
        const filename = event.filename ?? "";
        if (filename === "charter.md" || filename === "few-shots.md") {
          console.log(`Charter: ${filename} changed, reloading…`);
          try {
            await this.load();
            callback?.();
          } catch (loadErr) {
            console.error("Charter: hot-reload failed", loadErr);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    }
  }

  private async _readOptional(filePath: string): Promise<string> {
    try {
      return (await readFile(filePath, "utf-8")).trim();
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") return "";
      throw err;
    }
  }

  private _compose(charter: string, fewShots: string): string {
    const parts: string[] = [];

    if (charter) {
      parts.push(charter);
    }

    if (fewShots) {
      parts.push("=== Few-shots ===");
      parts.push(fewShots);
    }

    // Append the profile placeholder so setProfileSection has a hook.
    parts.push("<!-- profile -->");

    return parts.join("\n\n");
  }
}