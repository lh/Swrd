import { openDb } from '../db.js';

interface SessionStartInput {
  session_id: string;
  source: string; // 'startup' | 'resume' | 'clear' | 'compact'
}

/**
 * SessionStart hook — initialize the DB for new sessions.
 * On resume, the existing DB is reused automatically.
 */
export function sessionStart(input: SessionStartInput): void {
  const db = openDb(input.session_id);
  db.close();
}
