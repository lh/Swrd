import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { DB_DIR } from './config.js';

export function openDb(sessionId: string): Database.Database {
  mkdirSync(DB_DIR, { recursive: true });
  const dbPath = join(DB_DIR, `${sanitizeId(sessionId)}.db`);
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  if (!tableExists(db, 'entries')) {
    createSchema(db);
  }

  return db;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    `SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name) as { c: number } | undefined;
  return (row?.c ?? 0) > 0;
}

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_index INTEGER NOT NULL,
      file_path TEXT,
      entry_type TEXT NOT NULL,
      tool_calls TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      tags TEXT,
      related_files TEXT DEFAULT '[]',
      semantic_group TEXT,
      confidence REAL,
      low_relevance INTEGER DEFAULT 0,
      annotation_status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX idx_entries_prompt ON entries(prompt_index);
    CREATE INDEX idx_entries_type ON entries(entry_type);
    CREATE INDEX idx_entries_status ON entries(annotation_status);
    CREATE INDEX idx_entries_group ON entries(semantic_group);

    -- Standalone FTS5 table (not content-synced).
    -- We manage inserts/deletes manually for full control.
    CREATE VIRTUAL TABLE entries_fts USING fts5(
      file_path, description, tags, semantic_group,
      tokenize='porter unicode61'
    );

    -- Map FTS rowids back to entry IDs
    CREATE TABLE fts_map (
      fts_rowid INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE entry_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      link_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(source_id, target_id, link_type)
    );

    CREATE TABLE session_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// --- Session state helpers ---

export function getState(db: Database.Database, key: string): string | null {
  const row = db.prepare(
    `SELECT value FROM session_state WHERE key = ?`
  ).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT OR REPLACE INTO session_state (key, value) VALUES (?, ?)`
  ).run(key, value);
}

export function getPromptIndex(db: Database.Database): number {
  const v = getState(db, 'prompt_index');
  return v ? parseInt(v, 10) : 0;
}

export function setPromptIndex(db: Database.Database, idx: number) {
  setState(db, 'prompt_index', String(idx));
}

// --- Entry CRUD ---

export interface EntryRow {
  id: number;
  prompt_index: number;
  file_path: string | null;
  entry_type: string;
  tool_calls: string;
  description: string | null;
  tags: string | null;
  related_files: string;
  semantic_group: string | null;
  confidence: number | null;
  low_relevance: number;
  annotation_status: string;
  created_at: number;
}

export function insertEntry(
  db: Database.Database,
  promptIndex: number,
  filePath: string | null,
  entryType: string,
  toolCalls: object[]
): number {
  const info = db.prepare(`
    INSERT INTO entries (prompt_index, file_path, entry_type, tool_calls, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(promptIndex, filePath, entryType, JSON.stringify(toolCalls), Date.now());
  const entryId = Number(info.lastInsertRowid);

  // Insert into FTS with just the file_path for now (description/tags come after annotation)
  const ftsInfo = db.prepare(`
    INSERT INTO entries_fts(file_path, description, tags, semantic_group)
    VALUES (?, '', '', '')
  `).run(filePath ?? '');
  const ftsRowid = Number(ftsInfo.lastInsertRowid);

  db.prepare(`INSERT INTO fts_map (fts_rowid, entry_id) VALUES (?, ?)`).run(ftsRowid, entryId);

  return entryId;
}

export function annotateEntry(
  db: Database.Database,
  id: number,
  description: string,
  tags: string,
  semanticGroup: string,
  relatedFiles: string[],
  confidence: number,
  lowRelevance: boolean
) {
  // Update the entries table
  db.prepare(`
    UPDATE entries
    SET description = ?, tags = ?, semantic_group = ?,
        related_files = ?, confidence = ?, low_relevance = ?,
        annotation_status = 'annotated'
    WHERE id = ?
  `).run(
    description, tags, semanticGroup,
    JSON.stringify(relatedFiles), confidence,
    lowRelevance ? 1 : 0, id
  );

  // Get the file_path and FTS rowid for this entry
  const entry = db.prepare(`SELECT file_path FROM entries WHERE id = ?`).get(id) as
    { file_path: string | null } | undefined;
  const mapping = db.prepare(`SELECT fts_rowid FROM fts_map WHERE entry_id = ?`).get(id) as
    { fts_rowid: number } | undefined;

  if (mapping) {
    // Delete old FTS row and insert updated one
    db.prepare(`DELETE FROM entries_fts WHERE rowid = ?`).run(mapping.fts_rowid);
    db.prepare(`DELETE FROM fts_map WHERE entry_id = ?`).run(id);
  }

  // Insert new FTS row with full annotation data
  const ftsInfo = db.prepare(`
    INSERT INTO entries_fts(file_path, description, tags, semantic_group)
    VALUES (?, ?, ?, ?)
  `).run(entry?.file_path ?? '', description, tags, semanticGroup);
  const newFtsRowid = Number(ftsInfo.lastInsertRowid);

  db.prepare(`INSERT INTO fts_map (fts_rowid, entry_id) VALUES (?, ?)`).run(newFtsRowid, id);
}

export function insertSummaryEntry(
  db: Database.Database,
  promptIndex: number,
  summary: string,
  tags: string
): number {
  const info = db.prepare(`
    INSERT INTO entries (prompt_index, entry_type, description, tags,
                         annotation_status, created_at)
    VALUES (?, 'summary', ?, ?, 'annotated', ?)
  `).run(promptIndex, summary, tags, Date.now());

  const entryId = Number(info.lastInsertRowid);

  const ftsInfo = db.prepare(`
    INSERT INTO entries_fts(file_path, description, tags, semantic_group)
    VALUES ('', ?, ?, '')
  `).run(summary, tags);
  const ftsRowid = Number(ftsInfo.lastInsertRowid);

  db.prepare(`INSERT INTO fts_map (fts_rowid, entry_id) VALUES (?, ?)`).run(ftsRowid, entryId);

  return entryId;
}

export function insertLink(
  db: Database.Database,
  sourceId: number,
  targetId: number,
  linkType: string
) {
  db.prepare(`
    INSERT OR IGNORE INTO entry_links (source_id, target_id, link_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sourceId, targetId, linkType, Date.now());
}

export function markFailed(db: Database.Database, promptIndex: number) {
  db.prepare(`
    UPDATE entries SET annotation_status = 'failed'
    WHERE prompt_index = ? AND annotation_status IN ('pending', 'annotating')
  `).run(promptIndex);
}

export function getPendingEntries(db: Database.Database, promptIndex: number): EntryRow[] {
  return db.prepare(`
    SELECT * FROM entries
    WHERE prompt_index = ? AND annotation_status IN ('pending', 'annotating')
  `).all(promptIndex) as EntryRow[];
}

export function getFailedEntries(db: Database.Database, limit: number): EntryRow[] {
  return db.prepare(`
    SELECT * FROM entries
    WHERE annotation_status = 'failed'
    ORDER BY prompt_index DESC
    LIMIT ?
  `).all(limit) as EntryRow[];
}

export function getHistoricalEntries(db: Database.Database, beforePrompt: number, limit: number): EntryRow[] {
  return db.prepare(`
    SELECT * FROM entries
    WHERE annotation_status = 'annotated' AND prompt_index < ?
    ORDER BY prompt_index DESC
    LIMIT ?
  `).all(beforePrompt, limit) as EntryRow[];
}

export function markAnnotating(db: Database.Database, ids: number[]) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE entries SET annotation_status = 'annotating'
    WHERE id IN (${placeholders})
  `).run(...ids);
}

export function getEntryCount(db: Database.Database): { total: number; annotated: number; pending: number; failed: number } {
  const row = db.prepare(`
    SELECT
      count(*) as total,
      sum(CASE WHEN annotation_status = 'annotated' THEN 1 ELSE 0 END) as annotated,
      sum(CASE WHEN annotation_status = 'pending' THEN 1 ELSE 0 END) as pending,
      sum(CASE WHEN annotation_status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM entries
    WHERE entry_type != 'summary'
  `).get() as { total: number; annotated: number; pending: number; failed: number };
  return row;
}
