import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type Database from 'better-sqlite3';
import {
  annotateEntry, insertSummaryEntry, insertLink,
  markFailed, getPendingEntries, getFailedEntries,
  getHistoricalEntries, markAnnotating, getState,
  type EntryRow,
} from './db.js';
import { OBSERVER_MODEL, MAX_HISTORICAL_ENTRIES, MAX_ANNOTATION_TOKENS, type DistillConfig } from './config.js';

const SYSTEM_PROMPT = `You are a context indexer for a coding session.
Given entries from the latest prompt turn and historical entries from prior turns,
produce a JSON object with annotations, cross-prompt links, and a prompt summary.

For each current entry, produce an annotation with:
- entry_id: the entry's id
- description: 1-2 sentence summary of what this activity accomplished
- tags: comma-separated keywords for full-text search (include file names, function names, concepts, actions, technologies)
- related_files: array of other file paths related to this entry (from context or historical entries)
- low_relevance: true ONLY for trivial actions (checking file existence, failed reads, empty search results)
- confidence: 0.0-1.0 for how well you understand the entry's purpose given the context
- semantic_group: short kebab-case label grouping logically related entries (e.g. "auth-refactor", "test-setup", "bug-fix-login"). Reuse existing group labels from historical entries when the work is related.

Also produce:
- links: array connecting current entries to historical entries where meaningful relationships exist
  - source_entry_id: a current entry id
  - target_entry_id: a historical entry id
  - link_type: "depends_on" | "extends" | "reverts" | "related"
- prompt_summary: a summary of the entire turn
  - summary: 1-2 sentence overview of what was accomplished
  - tags: comma-separated keywords covering the turn

Respond with ONLY valid JSON matching this exact schema:
{
  "annotations": [
    {
      "entry_id": number,
      "description": string,
      "tags": string,
      "related_files": string[],
      "low_relevance": boolean,
      "confidence": number,
      "semantic_group": string
    }
  ],
  "links": [
    {
      "source_entry_id": number,
      "target_entry_id": number,
      "link_type": "depends_on" | "extends" | "reverts" | "related"
    }
  ],
  "prompt_summary": {
    "summary": string,
    "tags": string
  }
}`;

interface AnnotationResult {
  annotations?: Array<{
    entry_id: number;
    description: string;
    tags: string;
    related_files?: string[];
    low_relevance?: boolean;
    confidence?: number;
    semantic_group?: string;
  }>;
  links?: Array<{
    source_entry_id: number;
    target_entry_id: number;
    link_type: string;
  }>;
  prompt_summary?: {
    summary: string;
    tags: string;
  };
}

function buildUserMessage(
  userPrompt: string,
  currentEntries: EntryRow[],
  historical: EntryRow[],
  retries: EntryRow[]
): string {
  const parts: string[] = [];

  parts.push(`<user_prompt>${userPrompt}</user_prompt>`);

  const current = currentEntries.map(e => ({
    id: e.id,
    file_path: e.file_path,
    entry_type: e.entry_type,
    tool_calls: JSON.parse(e.tool_calls),
  }));
  parts.push(`<current_entries>\n${JSON.stringify(current, null, 2)}\n</current_entries>`);

  if (historical.length > 0) {
    const hist = historical.map(e => ({
      id: e.id,
      prompt_index: e.prompt_index,
      file_path: e.file_path,
      description: e.description,
      tags: e.tags,
      semantic_group: e.semantic_group,
    }));
    parts.push(`<historical_entries>\n${JSON.stringify(hist, null, 2)}\n</historical_entries>`);
  }

  if (retries.length > 0) {
    const retry = retries.map(e => ({
      id: e.id,
      prompt_index: e.prompt_index,
      file_path: e.file_path,
      entry_type: e.entry_type,
      tool_calls: JSON.parse(e.tool_calls),
    }));
    parts.push(`<retry_entries>\n${JSON.stringify(retry, null, 2)}\n</retry_entries>`);
  }

  return parts.join('\n\n');
}

/**
 * Call the LLM for annotation. Supports two API formats:
 * - 'anthropic': Anthropic Messages API (Claude, OpenRouter with Anthropic format)
 * - 'openai': OpenAI Chat Completions API (DeepSeek, OpenAI, Together, etc.)
 */
async function callLlm(
  systemPrompt: string,
  userMessage: string,
  config: DistillConfig
): Promise<string> {
  const apiKey = config.apiKey ?? process.env.DISTILL_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('No API key found (set DISTILL_API_KEY, ANTHROPIC_API_KEY, or apiKey in ~/.distill/config.json)');
  }

  const provider = config.provider ?? 'anthropic';
  const model = config.model ?? OBSERVER_MODEL;

  if (provider === 'openai') {
    const client = new OpenAI({
      apiKey,
      baseURL: config.apiBaseUrl ?? 'https://api.openai.com/v1',
    });

    const response = await client.chat.completions.create({
      model,
      max_tokens: MAX_ANNOTATION_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    return response.choices[0]?.message?.content ?? '';
  } else {
    // Anthropic format
    const clientOpts: Record<string, unknown> = { apiKey };
    if (config.apiBaseUrl) {
      clientOpts.baseURL = config.apiBaseUrl;
    }
    const client = new Anthropic(clientOpts as ConstructorParameters<typeof Anthropic>[0]);

    const response = await client.messages.create({
      model,
      max_tokens: MAX_ANNOTATION_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
  }
}

/**
 * Run LLM annotation for a given prompt's entries.
 * Called as a detached background process — errors are handled gracefully.
 *
 * Supports both Anthropic and OpenAI-compatible APIs (DeepSeek, etc.)
 * via the provider config field.
 */
export async function annotatePrompt(
  db: Database.Database,
  promptIndex: number,
  config?: DistillConfig
): Promise<void> {
  const pending = getPendingEntries(db, promptIndex);
  const retries = getFailedEntries(db, 10);
  const allEntries = [...pending, ...retries];

  if (allEntries.length === 0) return;

  markAnnotating(db, allEntries.map(e => e.id));

  const userPrompt = getState(db, `prompt_${promptIndex}`) ?? '(unknown)';
  const historical = getHistoricalEntries(db, promptIndex, MAX_HISTORICAL_ENTRIES);
  const userMessage = buildUserMessage(userPrompt, allEntries, historical, retries);

  try {
    const text = await callLlm(SYSTEM_PROMPT, userMessage, config ?? { annotator: 'haiku' });

    // Extract JSON — handle markdown code fences
    const jsonStr = text.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const result: AnnotationResult = JSON.parse(jsonStr);

    const annotatedIds = new Set<number>();

    for (const ann of result.annotations ?? []) {
      annotateEntry(
        db,
        ann.entry_id,
        ann.description,
        ann.tags,
        ann.semantic_group ?? '',
        ann.related_files ?? [],
        ann.confidence ?? 0.5,
        ann.low_relevance ?? false
      );
      annotatedIds.add(ann.entry_id);
    }

    for (const link of result.links ?? []) {
      insertLink(db, link.source_entry_id, link.target_entry_id, link.link_type);
    }

    if (result.prompt_summary) {
      insertSummaryEntry(db, promptIndex, result.prompt_summary.summary, result.prompt_summary.tags);
    }

    for (const entry of allEntries) {
      if (!annotatedIds.has(entry.id)) {
        db.prepare(`UPDATE entries SET annotation_status = 'failed' WHERE id = ?`).run(entry.id);
      }
    }
  } catch (e) {
    markFailed(db, promptIndex);
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`distill: annotation failed for prompt ${promptIndex}: ${msg}\n`);
  }
}
