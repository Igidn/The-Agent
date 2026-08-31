import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CompactionEvent, CompactionSink } from './types.js';

/**
 * Journaling sink for compaction epochs.
 *
 * v1 stand-in for the memory index (build order 5): every compaction epoch
 * is appended as one JSON line, including the dropped segment, so the
 * pipeline is observable and testable end to end. The memory milestone
 * replaces this class against the same CompactionSink interface.
 *
 * The raw transcript never leaves the pi session jsonl on disk; this file
 * is the daemon's own index over what each epoch dropped.
 */
export class JsonlCompactionSink implements CompactionSink {
  /**
   * @param path  Output file. Parent directories are created on first write.
   */
  constructor(private _path: string = 'data/compaction-audit.jsonl') {}

  get path(): string {
    return this._path;
  }

  /**
   * Append one epoch. A write failure is logged and swallowed: losing an
   * audit line must never fail the compaction that produced it.
   */
  async recordCompaction(event: CompactionEvent): Promise<void> {
    try {
      await mkdir(dirname(this._path), { recursive: true });
      await appendFile(this._path, JSON.stringify(event) + '\n', 'utf-8');
    } catch (err) {
      console.warn(`Compaction: audit write failed (${this._path})`, err);
    }
  }
}
