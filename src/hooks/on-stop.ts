import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { openDb, getPromptIndex } from '../db.js';
import { flushToEntries, type BufferedCall } from '../entry-tracker.js';
import { selfAnnotatePrompt } from '../self-annotate.js';
import { loadConfig, BUFFER_DIR } from '../config.js';

interface StopInput {
  session_id: string;
}

/**
 * Stop hook — fires when Claude finishes a response.
 *
 * 1. Read the JSONL buffer of tool calls from this turn
 * 2. Flush them into the SQLite DB as entries
 * 3. Annotate:
 *    - 'self' mode (default): instant rule-based annotation, no API needed
 *    - 'haiku' mode: self-annotate first (for immediate retrieval),
 *      then spawn background Haiku process to upgrade annotations
 */
export function onStop(input: StopInput): void {
  const sanitized = input.session_id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const bufferPath = join(BUFFER_DIR, `${sanitized}.jsonl`);

  if (!existsSync(bufferPath)) return;

  const raw = readFileSync(bufferPath, 'utf8').trim();
  writeFileSync(bufferPath, '');

  if (!raw) return;

  const calls: BufferedCall[] = raw
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter((c): c is BufferedCall => c !== null);

  if (calls.length === 0) return;

  const db = openDb(input.session_id);
  const promptIndex = getPromptIndex(db);
  const config = loadConfig();

  try {
    flushToEntries(db, promptIndex, calls);

    // Always self-annotate first (instant, ensures retrieval works immediately)
    selfAnnotatePrompt(db, promptIndex);
  } finally {
    db.close();
  }

  // If haiku mode, also spawn background process for richer annotations
  if (config.annotator === 'haiku') {
    const thisFile = fileURLToPath(import.meta.url);
    const cliPath = join(dirname(thisFile), '..', 'cli.js');

    const child = spawn(process.execPath, [
      cliPath, 'annotate', input.session_id, String(promptIndex),
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  }
}
