import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BUFFER_DIR } from '../config.js';

interface ToolInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/**
 * PostToolUse hook (async) — buffer each tool call to a JSONL file.
 *
 * Runs asynchronously so it never blocks Claude.
 * The buffer is flushed into the DB when the Stop hook fires.
 */
export function onTool(input: ToolInput): void {
  if (!input?.session_id || !input?.tool_name) return;

  mkdirSync(BUFFER_DIR, { recursive: true });

  const sanitized = input.session_id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const bufferPath = join(BUFFER_DIR, `${sanitized}.jsonl`);

  const line = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    ts: Date.now(),
  });

  appendFileSync(bufferPath, line + '\n');
}
