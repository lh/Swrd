import type Database from 'better-sqlite3';
import {
  STOPWORDS, TOKEN_BUDGET, CHARS_PER_TOKEN,
  FTS_RESULT_LIMIT, GROUP_EXPANSION_LIMIT, FTS_MAX_TERMS,
} from './config.js';

interface FtsEntry {
  id: number;
  prompt_index: number;
  file_path: string | null;
  entry_type: string;
  description: string;
  semantic_group: string | null;
  rank: number;
}

/**
 * Build an FTS5 MATCH query from a user prompt.
 * Tokenizes, removes stopwords, quotes each term, joins with OR.
 */
function buildFtsQuery(prompt: string): string | null {
  const tokens = prompt
    .toLowerCase()
    .replace(/[^\w\s\/\.\-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, FTS_MAX_TERMS);

  if (tokens.length === 0) return null;

  // Quote each token for exact matching, join with OR
  return tokens.map(t => `"${t}"`).join(' OR ');
}

/**
 * BM25 search against the FTS5 index.
 */
function searchFts(
  db: Database.Database,
  query: string,
  currentPrompt: number,
  limit: number
): FtsEntry[] {
  return db.prepare(`
    SELECT ce.id, ce.prompt_index, ce.file_path, ce.entry_type,
           ce.description, ce.semantic_group, fts.rank
    FROM entries_fts fts
    JOIN fts_map fm ON fm.fts_rowid = fts.rowid
    JOIN entries ce ON ce.id = fm.entry_id
    WHERE entries_fts MATCH ?
      AND ce.low_relevance = 0
      AND ce.annotation_status = 'annotated'
      AND ce.prompt_index < ?
    ORDER BY fts.rank
    LIMIT ?
  `).all(query, currentPrompt, limit) as FtsEntry[];
}

/**
 * Get the summary entry from the previous prompt (for continuity).
 */
function getPreviousSummary(db: Database.Database, promptIndex: number): string | null {
  const row = db.prepare(`
    SELECT description FROM entries
    WHERE prompt_index = ? AND entry_type = 'summary'
    LIMIT 1
  `).get(promptIndex - 1) as { description: string } | undefined;
  return row?.description ?? null;
}

/**
 * Expand semantic groups: for each group found in results,
 * fetch a few more entries from the same group.
 */
function expandGroups(
  db: Database.Database,
  groups: Set<string>,
  excludeIds: Set<number>,
  currentPrompt: number
): FtsEntry[] {
  const extra: FtsEntry[] = [];
  for (const group of groups) {
    const placeholders = [...excludeIds].map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, prompt_index, file_path, entry_type, description, semantic_group, 0 as rank
      FROM entries
      WHERE semantic_group = ?
        AND low_relevance = 0
        AND annotation_status = 'annotated'
        AND prompt_index < ?
        ${excludeIds.size > 0 ? `AND id NOT IN (${placeholders})` : ''}
      ORDER BY prompt_index DESC
      LIMIT ?
    `).all(
      group, currentPrompt,
      ...(excludeIds.size > 0 ? [...excludeIds] : []),
      GROUP_EXPANSION_LIMIT
    ) as FtsEntry[];
    extra.push(...rows);
  }
  return extra;
}

/**
 * Format a single entry as a context line.
 */
function formatEntry(e: FtsEntry): string {
  const loc = e.file_path ?? e.entry_type;
  const group = e.semantic_group ? ` (${e.semantic_group})` : '';
  return `[Prompt ${e.prompt_index}]: ${loc}${group} — ${e.description}`;
}

/**
 * Main retrieval function.
 * Queries FTS5, expands groups, assembles context within token budget.
 */
export function retrieveContext(
  db: Database.Database,
  userPrompt: string,
  currentPromptIndex: number,
  tokenBudget: number = TOKEN_BUDGET
): string | null {
  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const sections: string[] = [];
  let usedChars = 0;

  // 1. Continuity: summary of the previous turn
  const prevSummary = getPreviousSummary(db, currentPromptIndex);
  if (prevSummary) {
    const block = `<last_activity>\n${prevSummary}\n</last_activity>`;
    sections.push(block);
    usedChars += block.length;
  }

  // 2. BM25 retrieval
  const ftsQuery = buildFtsQuery(userPrompt);
  if (!ftsQuery) {
    return sections.length ? wrapContext(sections) : null;
  }

  const results = searchFts(db, ftsQuery, currentPromptIndex, FTS_RESULT_LIMIT);
  if (results.length === 0 && sections.length === 0) return null;

  const contextLines: string[] = [];
  const selectedIds = new Set<number>();
  const seenGroups = new Set<string>();

  for (const entry of results) {
    if (!entry.description) continue;
    const line = formatEntry(entry);
    if (usedChars + line.length > charBudget) break;
    contextLines.push(line);
    usedChars += line.length;
    selectedIds.add(entry.id);
    if (entry.semantic_group) seenGroups.add(entry.semantic_group);
  }

  // 3. Expand semantic groups
  if (seenGroups.size > 0 && usedChars < charBudget) {
    const groupEntries = expandGroups(db, seenGroups, selectedIds, currentPromptIndex);
    for (const entry of groupEntries) {
      if (!entry.description) continue;
      const line = formatEntry(entry);
      if (usedChars + line.length > charBudget) break;
      contextLines.push(line);
      usedChars += line.length;
      selectedIds.add(entry.id);
    }
  }

  if (contextLines.length > 0) {
    sections.push(
      `<relevant_context>\n${contextLines.join('\n')}\n</relevant_context>`
    );
  }

  return sections.length ? wrapContext(sections) : null;
}

function wrapContext(sections: string[]): string {
  return `<distilled_session_context>\n${sections.join('\n\n')}\n</distilled_session_context>`;
}
