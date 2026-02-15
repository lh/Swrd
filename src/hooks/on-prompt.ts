import { openDb, getPromptIndex, setPromptIndex, setState } from '../db.js';
import { retrieveContext } from '../retrieve.js';

interface PromptInput {
  session_id: string;
  prompt: string;
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
}

/**
 * UserPromptSubmit hook — the critical path.
 *
 * 1. Increment prompt index
 * 2. Store the user prompt (for later annotation)
 * 3. Retrieve relevant context from prior turns via FTS5
 * 4. Return additionalContext for injection into Claude's input
 */
export function onPrompt(input: PromptInput): HookOutput {
  const db = openDb(input.session_id);

  try {
    const idx = getPromptIndex(db) + 1;
    setPromptIndex(db, idx);

    // Store user prompt for the annotation step
    setState(db, `prompt_${idx}`, input.prompt);

    // First prompt — nothing to retrieve yet
    if (idx <= 1) {
      return {};
    }

    const context = retrieveContext(db, input.prompt, idx);
    if (context) {
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: context,
        },
      };
    }

    return {};
  } finally {
    db.close();
  }
}
