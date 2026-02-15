import { insertEntry } from './db.js';
import { IGNORED_TOOLS, FILE_TOOLS, WRITE_TOOLS, TOOL_KEY_FIELDS } from './config.js';
import type Database from 'better-sqlite3';

export interface BufferedCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  ts: number;
}

/**
 * Groups buffered tool calls into logical DB entries.
 *
 * - File tools (Read/Write/Edit/Glob/Grep) are grouped by file_path
 * - Bash/Web/other tools each get their own entry
 * - Ignored tools (planning, todos) are skipped
 *
 * Returns the IDs of inserted entries.
 */
export function flushToEntries(
  db: Database.Database,
  promptIndex: number,
  calls: BufferedCall[]
): number[] {
  const fileGroups = new Map<string, BufferedCall[]>();
  const standalone: BufferedCall[] = [];

  for (const call of calls) {
    if (IGNORED_TOOLS.has(call.tool_name)) continue;

    if (FILE_TOOLS.has(call.tool_name)) {
      const fp = (call.tool_input.file_path as string)
        ?? (call.tool_input.notebook_path as string)
        ?? '_unknown';
      const group = fileGroups.get(fp) ?? [];
      group.push(call);
      fileGroups.set(fp, group);
    } else {
      standalone.push(call);
    }
  }

  const ids: number[] = [];

  // File-grouped entries
  for (const [filePath, group] of fileGroups) {
    const hasWrite = group.some(c => WRITE_TOOLS.has(c.tool_name));
    const entryType = hasWrite ? 'file_change' : 'research';
    const summarized = group.map(summarizeCall);
    ids.push(insertEntry(db, promptIndex, filePath, entryType, summarized));
  }

  // Standalone entries
  for (const call of standalone) {
    const entryType = classifyTool(call.tool_name);
    const keyField = TOOL_KEY_FIELDS[call.tool_name];
    const filePath = keyField ? truncate(String(call.tool_input[keyField] ?? ''), 500) : null;
    ids.push(insertEntry(db, promptIndex, filePath, entryType, [summarizeCall(call)]));
  }

  return ids;
}

function classifyTool(name: string): string {
  if (name === 'Bash') return 'command';
  if (name === 'WebSearch' || name === 'WebFetch') return 'web';
  if (name === 'Task') return 'research';
  return 'research';
}

/**
 * Produce a compact summary of a tool call for storage.
 * We don't need the full input — just enough for Haiku to understand.
 */
function summarizeCall(call: BufferedCall): object {
  const { tool_name, tool_input } = call;
  const summary: Record<string, unknown> = { tool: tool_name };

  const keyField = TOOL_KEY_FIELDS[tool_name];
  if (keyField && tool_input[keyField] !== undefined) {
    summary[keyField] = truncate(String(tool_input[keyField]), 300);
  }

  // Include a few extra fields for context
  if (tool_name === 'Edit') {
    if (tool_input.old_string) summary.old_string = truncate(String(tool_input.old_string), 200);
    if (tool_input.new_string) summary.new_string = truncate(String(tool_input.new_string), 200);
  } else if (tool_name === 'Grep') {
    if (tool_input.glob) summary.glob = tool_input.glob;
    if (tool_input.path) summary.path = tool_input.path;
  } else if (tool_name === 'Bash') {
    if (tool_input.description) summary.description = truncate(String(tool_input.description), 200);
  } else if (tool_name === 'Task') {
    if (tool_input.description) summary.description = truncate(String(tool_input.description), 200);
  }

  return summary;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
