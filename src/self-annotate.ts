import type Database from 'better-sqlite3';
import {
  annotateEntry, insertSummaryEntry,
  getPendingEntries, getState,
  type EntryRow,
} from './db.js';

/**
 * Rule-based self-annotation — no API key needed.
 *
 * Derives descriptions, tags, and semantic groups directly from
 * the tool call data. Not as good as Haiku, but free and instant.
 */
export function selfAnnotatePrompt(
  db: Database.Database,
  promptIndex: number
): void {
  const entries = getPendingEntries(db, promptIndex);
  if (entries.length === 0) return;

  const userPrompt = getState(db, `prompt_${promptIndex}`) ?? '';
  const summaryParts: string[] = [];

  for (const entry of entries) {
    const calls = JSON.parse(entry.tool_calls) as Array<Record<string, unknown>>;
    const description = buildDescription(entry, calls);
    const tags = buildTags(entry, calls, userPrompt);
    const group = buildGroup(entry);

    annotateEntry(db, entry.id, description, tags, group, [], 0.3, isLowRelevance(entry, calls));
    summaryParts.push(description);
  }

  // Build prompt summary
  const summary = summaryParts.length === 1
    ? summaryParts[0]
    : `${summaryParts.length} activities: ${summaryParts.slice(0, 3).join('; ')}${summaryParts.length > 3 ? '...' : ''}`;

  const allTags = entries.map(e => buildTags(e, JSON.parse(e.tool_calls), userPrompt)).join(',');
  const uniqueTags = [...new Set(allTags.split(',').filter(Boolean))].join(',');

  insertSummaryEntry(db, promptIndex, summary, uniqueTags);
}

function buildDescription(entry: EntryRow, calls: Array<Record<string, unknown>>): string {
  const fp = entry.file_path;
  const shortPath = fp ? shortenPath(fp) : '';

  switch (entry.entry_type) {
    case 'file_change': {
      const tools = calls.map(c => c.tool as string);
      if (tools.includes('Write') && !tools.includes('Edit')) {
        return `Created ${shortPath}`;
      }
      if (tools.includes('Edit')) {
        const editCalls = calls.filter(c => c.tool === 'Edit');
        return `Modified ${shortPath} (${editCalls.length} edit${editCalls.length > 1 ? 's' : ''})`;
      }
      return `Changed ${shortPath}`;
    }
    case 'research': {
      const tools = calls.map(c => c.tool as string);
      if (tools.includes('Glob') || tools.includes('Grep')) {
        const pattern = calls.find(c => c.pattern)?.pattern as string | undefined;
        return pattern ? `Searched for "${truncate(String(pattern), 60)}"` : `Explored ${shortPath || 'codebase'}`;
      }
      if (tools.includes('Read')) {
        return `Read ${shortPath}`;
      }
      if (tools.includes('Task')) {
        const desc = calls.find(c => c.description)?.description as string | undefined;
        return desc ? `Subagent: ${truncate(String(desc), 80)}` : 'Ran subagent task';
      }
      return `Researched ${shortPath || 'codebase'}`;
    }
    case 'command': {
      const cmd = calls[0]?.command as string | undefined;
      const desc = calls[0]?.description as string | undefined;
      if (desc) return `Ran: ${truncate(String(desc), 80)}`;
      if (cmd) return `Ran: ${truncate(String(cmd), 80)}`;
      return 'Ran shell command';
    }
    case 'web': {
      const query = calls[0]?.query as string | undefined;
      const url = calls[0]?.url as string | undefined;
      if (query) return `Web search: ${truncate(String(query), 80)}`;
      if (url) return `Fetched: ${truncate(String(url), 80)}`;
      return 'Web activity';
    }
    default:
      return `${entry.entry_type} on ${shortPath || 'unknown'}`;
  }
}

function buildTags(entry: EntryRow, calls: Array<Record<string, unknown>>, userPrompt: string): string {
  const tags = new Set<string>();

  // Tags from file path
  if (entry.file_path) {
    const parts = entry.file_path.split('/').filter(Boolean);
    // Add filename
    const filename = parts[parts.length - 1];
    if (filename) tags.add(filename);
    // Add extension
    const ext = filename?.split('.').pop();
    if (ext && ext !== filename) tags.add(ext);
    // Add parent directory
    if (parts.length >= 2) tags.add(parts[parts.length - 2]);
  }

  // Tags from entry type
  tags.add(entry.entry_type);

  // Tags from tool names
  for (const call of calls) {
    if (call.tool) tags.add(String(call.tool).toLowerCase());
  }

  // Tags from command descriptions
  for (const call of calls) {
    if (call.description) {
      extractKeywords(String(call.description)).forEach(k => tags.add(k));
    }
  }

  // A few keywords from the user prompt
  extractKeywords(userPrompt).slice(0, 5).forEach(k => tags.add(k));

  return [...tags].join(',');
}

function buildGroup(entry: EntryRow): string {
  if (!entry.file_path) return entry.entry_type;

  // Group by parent directory
  const parts = entry.file_path.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return parts[0] ?? entry.entry_type;
}

function isLowRelevance(entry: EntryRow, calls: Array<Record<string, unknown>>): boolean {
  // Single read with no other context is low relevance
  if (entry.entry_type === 'research' && calls.length === 1) {
    const tool = calls[0]?.tool as string | undefined;
    if (tool === 'Glob' || tool === 'Grep') return false; // searches are useful
    // A single Read is borderline — keep it
  }
  return false;
}

function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-3).join('/');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

const KEYWORD_STOPS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'and', 'or', 'but', 'not', 'this', 'that', 'it', 'its',
  'run', 'running', 'use', 'using', 'all',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !KEYWORD_STOPS.has(w));
}
