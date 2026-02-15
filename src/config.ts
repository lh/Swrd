import { join } from 'path';
import { homedir } from 'os';
import { readFileSync } from 'fs';

// Paths
export const DISTILL_DIR = join(homedir(), '.distill');
export const DB_DIR = join(DISTILL_DIR, 'sessions');
export const BUFFER_DIR = join(DISTILL_DIR, 'buffers');
export const CONFIG_FILE = join(DISTILL_DIR, 'config.json');

// User config (loaded from ~/.distill/config.json)
export interface DistillConfig {
  // 'self' = rule-based (free, instant), 'haiku' = API-powered (richer but costs money)
  annotator: 'self' | 'haiku';
  // API provider format: 'anthropic' or 'openai' (DeepSeek, OpenAI, Together, etc.)
  provider?: 'anthropic' | 'openai';
  // API base URL (e.g. https://api.deepseek.com, https://openrouter.ai/api/v1)
  apiBaseUrl?: string;
  // API key (or set DISTILL_API_KEY env var)
  apiKey?: string;
  // Model to use for annotation
  model?: string;
  // Token budget for injected context (default: 4000)
  tokenBudget?: number;
}

export function loadConfig(): DistillConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    return { annotator: 'self', ...JSON.parse(raw) };
  } catch {
    return { annotator: 'self' };
  }
}

// Token budget for injected context
export const TOKEN_BUDGET = 4000;
export const CHARS_PER_TOKEN = 4;

// Retrieval limits
export const FTS_RESULT_LIMIT = 50;
export const GROUP_EXPANSION_LIMIT = 3;
export const FTS_MAX_TERMS = 16;

// Annotation
export const OBSERVER_MODEL = 'claude-haiku-4-5-20251001';
export const MAX_HISTORICAL_ENTRIES = 30;
export const MAX_ANNOTATION_TOKENS = 4096;

// Tools that we skip indexing for (meta/planning tools)
export const IGNORED_TOOLS = new Set([
  'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion',
  'TodoRead', 'TodoWrite', 'TaskCreate', 'TaskUpdate',
  'TaskList', 'TaskGet',
]);

// Tools that operate on files (grouped by file_path)
export const FILE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit',
]);

// Tools that modify files
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

// Which input field identifies the key for each tool
export const TOOL_KEY_FIELDS: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'pattern',
  Grep: 'pattern',
  Bash: 'command',
  WebSearch: 'query',
  WebFetch: 'url',
  Task: 'prompt',
};

// Stopwords excluded from FTS queries
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'this', 'that', 'these', 'those', 'it', 'its', 'and', 'or',
  'but', 'not', 'no', 'if', 'then', 'else', 'when', 'where',
  'how', 'what', 'which', 'who', 'whom', 'why', 'all', 'each',
  'any', 'some', 'such', 'than', 'too', 'very', 'just', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further',
  'once', 'here', 'there', 'also', 'both', 'few', 'more', 'most',
  'other', 'only', 'own', 'same', 'so', 'up', 'down', 'now',
  'file', 'code', 'use', 'using', 'used', 'make', 'like',
  'need', 'want', 'get', 'set', 'add', 'new', 'please',
]);
