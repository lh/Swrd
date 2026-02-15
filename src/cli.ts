#!/usr/bin/env node

import { readFileSync } from 'fs';
import { sessionStart } from './hooks/session-start.js';
import { onPrompt } from './hooks/on-prompt.js';
import { onTool } from './hooks/on-tool.js';
import { onStop } from './hooks/on-stop.js';
import { annotatePrompt } from './annotate.js';
import { openDb, getEntryCount, getPromptIndex } from './db.js';
import { loadConfig } from './config.js';
import { isEnabled } from './gate.js';

const cmd = process.argv[2];

/** Hook commands that should respect the per-project gate */
const GATED_COMMANDS = new Set(['session-start', 'on-prompt', 'on-tool', 'on-stop']);

/**
 * Read JSON from stdin (non-blocking — returns null if stdin is a TTY with no data).
 */
function readStdin(): unknown {
  try {
    const data = readFileSync('/dev/stdin', 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Write JSON to stdout (for hook responses).
 */
function respond(obj: object) {
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  try {
    // For hook commands, check if distill is enabled for this project
    if (GATED_COMMANDS.has(cmd ?? '')) {
      const raw = readStdin() as Record<string, unknown>;
      const cwd = raw.cwd as string | undefined;

      if (!isEnabled(cwd)) {
        respond({});
        return;
      }

      // Dispatch to hook handlers with the already-parsed input
      switch (cmd) {
        case 'session-start':
          sessionStart(raw as { session_id: string; source: string });
          respond({});
          return;
        case 'on-prompt': {
          const result = onPrompt(raw as { session_id: string; prompt: string });
          respond(result);
          return;
        }
        case 'on-tool':
          onTool(raw as { session_id: string; tool_name: string; tool_input: Record<string, unknown> });
          respond({});
          return;
        case 'on-stop':
          onStop(raw as { session_id: string });
          respond({});
          return;
      }
    }

    switch (cmd) {

      // --- Background annotation (spawned by on-stop) ---

      case 'annotate': {
        const sessionId = process.argv[3];
        const promptIndex = parseInt(process.argv[4], 10);
        if (!sessionId || isNaN(promptIndex)) {
          process.stderr.write('Usage: distill annotate <session_id> <prompt_index>\n');
          process.exit(1);
        }
        const db = openDb(sessionId);
        const config = loadConfig();
        try {
          await annotatePrompt(db, promptIndex, config);
        } finally {
          db.close();
        }
        break;
      }

      // --- Utility commands ---

      case 'status': {
        const sessionId = process.argv[3];
        if (!sessionId) {
          process.stderr.write('Usage: distill status <session_id>\n');
          process.exit(1);
        }
        const db = openDb(sessionId);
        const counts = getEntryCount(db);
        const promptIdx = getPromptIndex(db);
        db.close();

        console.log(`Session: ${sessionId}`);
        console.log(`Prompts: ${promptIdx}`);
        console.log(`Entries: ${counts.total} (annotated: ${counts.annotated}, pending: ${counts.pending}, failed: ${counts.failed})`);
        break;
      }

      case 'inspect': {
        const sessionId = process.argv[3];
        if (!sessionId) {
          process.stderr.write('Usage: distill inspect <session_id>\n');
          process.exit(1);
        }
        const db = openDb(sessionId);
        const rows = db.prepare(`
          SELECT id, prompt_index, file_path, entry_type, description,
                 semantic_group, annotation_status
          FROM entries
          ORDER BY prompt_index, id
        `).all() as Array<{
          id: number; prompt_index: number; file_path: string | null;
          entry_type: string; description: string | null;
          semantic_group: string | null; annotation_status: string;
        }>;
        db.close();

        let currentPrompt = -1;
        for (const row of rows) {
          if (row.prompt_index !== currentPrompt) {
            currentPrompt = row.prompt_index;
            console.log(`\n── Prompt ${currentPrompt} ──`);
          }
          const status = row.annotation_status === 'annotated' ? '✓' : row.annotation_status === 'failed' ? '✗' : '…';
          const group = row.semantic_group ? ` [${row.semantic_group}]` : '';
          const desc = row.description ?? '(not annotated)';
          const path = row.file_path ? ` ${row.file_path}` : '';
          console.log(`  ${status} #${row.id} ${row.entry_type}${path}${group}`);
          if (row.description) {
            console.log(`    ${desc}`);
          }
        }
        break;
      }

      case 'search': {
        const sessionId = process.argv[3];
        const query = process.argv.slice(4).join(' ');
        if (!sessionId || !query) {
          process.stderr.write('Usage: distill search <session_id> <query...>\n');
          process.exit(1);
        }
        const db = openDb(sessionId);
        const promptIdx = getPromptIndex(db);

        // Import retrieve inline to get the context
        const { retrieveContext } = await import('./retrieve.js');
        const context = retrieveContext(db, query, promptIdx + 1);
        db.close();

        if (context) {
          console.log(context);
        } else {
          console.log('No relevant context found.');
        }
        break;
      }

      case 'sessions': {
        const { readdirSync, statSync } = await import('fs');
        const { join } = await import('path');
        const { DB_DIR } = await import('./config.js');
        try {
          const files = readdirSync(DB_DIR)
            .filter(f => f.endsWith('.db'))
            .map(f => {
              const fullPath = join(DB_DIR, f);
              const stat = statSync(fullPath);
              return { name: f.replace('.db', ''), modified: stat.mtime };
            })
            .sort((a, b) => b.modified.getTime() - a.modified.getTime());

          if (files.length === 0) {
            console.log('No distill sessions found.');
          } else {
            console.log('Sessions (most recent first):');
            for (const f of files) {
              console.log(`  ${f.name}  (${f.modified.toISOString().slice(0, 19)})`);
            }
          }
        } catch {
          console.log('No distill sessions found.');
        }
        break;
      }

      default: {
        console.log(`distill — context distillation for Claude Code

Hook commands (called by Claude Code):
  session-start    Initialize DB for a session
  on-prompt        Retrieve and inject context
  on-tool          Buffer a tool call
  on-stop          Flush buffer and trigger annotation

Background:
  annotate <session_id> <prompt_index>
                   Run Haiku annotation (spawned by on-stop)

Utilities:
  sessions         List all distill sessions
  status <id>      Show session stats
  inspect <id>     Show all entries in a session
  search <id> <q>  Test retrieval for a query`);
        break;
      }
    }
  } catch (err) {
    // Hooks must never crash — always return empty JSON on error
    if (['session-start', 'on-prompt', 'on-tool', 'on-stop'].includes(cmd ?? '')) {
      process.stderr.write(`distill hook error (${cmd}): ${err instanceof Error ? err.message : String(err)}\n`);
      respond({});
    } else {
      throw err;
    }
  }
}

main();
