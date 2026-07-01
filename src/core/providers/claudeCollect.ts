import * as fs from 'fs';
import {
  ParsedSession,
  SessionInfo,
  LLMRequestRecord,
  UserMessageRecord,
  ToolCallRecord,
  ModelInfo,
} from '../types';
import { ensureClaudeModel } from './claudeModels';

const PREVIEW_LENGTH = 200;
const MAX_DETAIL = 16000; // per-field cap so the DB stays bounded

function cap(s: string): string {
  return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + `\n…[truncated ${s.length - MAX_DETAIL} chars]` : s;
}

/** Flatten a Claude content value (string | block[]) into readable text. */
function stringifyContent(c: unknown): string {
  if (typeof c === 'string') { return c; }
  if (Array.isArray(c)) {
    return c.map(b => {
      if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>;
        if (typeof o.text === 'string') { return o.text; }
        return JSON.stringify(o);
      }
      return typeof b === 'string' ? b : JSON.stringify(b);
    }).join('\n');
  }
  if (c == null) { return ''; }
  try { return JSON.stringify(c, null, 2); } catch { return String(c); }
}

// ---- Raw Claude transcript line shapes (only the fields we read) -----------

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // TTL breakdown of cache_creation_input_tokens. 1h writes are billed at 2x base
  // input (vs 1.25x for 5m), so the split is needed for accurate cost.
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}
interface ClaudeContentBlock {
  type?: string;
  name?: string;
  id?: string;
  text?: string;
  thinking?: string;
  input?: unknown;        // tool_use input (the command/script/file edit)
  tool_use_id?: string;   // tool_result back-reference
  is_error?: boolean;     // tool_result error flag
  content?: unknown;      // tool_result output (string | block[])
}
interface ClaudeMessage {
  role?: string;
  model?: string;
  usage?: ClaudeUsage;
  content?: string | ClaudeContentBlock[];
}
interface ClaudeLine {
  type?: string;
  uuid?: string;
  requestId?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  message?: ClaudeMessage;
}

export interface ClaudeCollected {
  session: SessionInfo | null;
  llmRequests: LLMRequestRecord[];
  userMessages: UserMessageRecord[];
  toolCalls: ToolCallRecord[];
  turnCount: number;
}

/** Read a JSONL file into parsed objects, skipping blank/corrupt lines. */
export function readJsonlLines(filePath: string): ClaudeLine[] {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const out: ClaudeLine[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) { continue; }
    try { out.push(JSON.parse(t) as ClaudeLine); } catch { /* skip corrupt line */ }
  }
  return out;
}

function tsToMs(iso: string | undefined): number {
  if (!iso) { return 0; }
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Collect Claude transcript lines into normalized records.
 *
 * CRITICAL (verified against real transcripts, CLAUDE-PROVIDER-PLAN.md §3.3):
 * Claude Code writes ONE API response as MULTIPLE assistant lines — one per
 * content block (thinking/text/tool_use…) — all sharing the same `requestId`
 * and an IDENTICAL `usage` snapshot. We therefore group assistant lines by
 * `requestId` and emit exactly ONE LLMRequestRecord per group (span_id =
 * requestId), counting usage once. Naive per-line summing over-counts ~2.7×.
 *
 * `inputTokens` is stored INCLUSIVE of cache (input + cache_read + cache_creation)
 * so the shared cost engine's `uncachedIn = inputTokens - cached - cacheWrite`
 * recovers the right uncached bucket and totals match Copilot semantics (§3.6).
 */
export function collectClaudeEvents(
  lines: ClaudeLine[],
  sessionId: string,
  workspaceId: string,
  dirPath: string,
  models: Map<string, ModelInfo>,
  isSubagentFile: boolean,
  subagentName: string | undefined,
): ClaudeCollected {
  const llmRequests: LLMRequestRecord[] = [];
  const userMessages: UserMessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = 0;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let sawAny = false;

  // requestId -> the assistant lines belonging to that single API response.
  const groups = new Map<string, ClaudeLine[]>();
  // tool_use_id -> the tool's output (from tool_result blocks in user lines).
  const toolResults = new Map<string, { text: string; isError: boolean }>();

  for (const line of lines) {
    const ms = tsToMs(line.timestamp);
    if (ms > 0) { sawAny = true; if (ms < minTs) { minTs = ms; } if (ms > maxTs) { maxTs = ms; } }
    if (line.cwd && !cwd) { cwd = line.cwd; }
    if (line.gitBranch && !gitBranch) { gitBranch = line.gitBranch; }
    if (line.version && !version) { version = line.version; }

    if (line.type === 'assistant' && line.message) {
      const rid = line.requestId || line.uuid;
      if (!rid) { continue; } // never emit an empty span_id (would break dedup)
      const arr = groups.get(rid);
      if (arr) { arr.push(line); } else { groups.set(rid, [line]); }
    } else if (line.type === 'user' && line.message) {
      const content = line.message.content;
      let text: string | undefined;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        // A user line is either a genuine prompt (text blocks) or tool results
        // (tool_result blocks — NOT a user message; the tool_use already counts).
        const textParts = content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text as string);
        if (textParts.length > 0) { text = textParts.join('\n'); }
        // Capture tool outputs, keyed by the tool_use id they answer.
        for (const b of content) {
          if (b && b.type === 'tool_result' && b.tool_use_id) {
            toolResults.set(b.tool_use_id, { text: cap(stringifyContent(b.content)), isError: !!b.is_error });
          }
        }
      }
      if (text !== undefined) {
        userMessages.push({
          sessionId,
          spanId: line.uuid || '',
          timestamp: ms,
          contentLength: text.length,
          contentPreview: text.substring(0, PREVIEW_LENGTH),
          contentFull: cap(text),
        });
      }
    }
  }

  // Emit one LLMRequestRecord per requestId group + tool calls across the group.
  for (const [rid, groupLines] of groups) {
    const first = groupLines[0];
    const msg = first.message!;
    const usage = msg.usage ?? {};
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreate1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cacheCreate5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    // Prefer the flat total; fall back to the TTL breakdown sum when it's absent.
    const cacheCreate = usage.cache_creation_input_tokens ?? (cacheCreate5m + cacheCreate1h);
    const freshInput = usage.input_tokens ?? 0;
    const inclusiveInput = freshInput + cacheRead + cacheCreate; // §3.6 inclusive storage
    const outputTokens = usage.output_tokens ?? 0;
    const model = msg.model || 'unknown';
    ensureClaudeModel(models, model);

    // Earliest timestamp + sidechain flag come from the group. Also collect the
    // assistant's generated text + thinking, and enrich each tool call with its
    // input (command/script/edit) and the result it produced.
    let groupTs = Number.POSITIVE_INFINITY;
    let isSidechain = isSubagentFile;
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    for (const gl of groupLines) {
      const ms = tsToMs(gl.timestamp);
      if (ms > 0 && ms < groupTs) { groupTs = ms; }
      if (gl.isSidechain) { isSidechain = true; }
      const content = gl.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block) { continue; }
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            thinkingParts.push(block.thinking);
          } else if (block.type === 'tool_use') {
            const res = block.id ? toolResults.get(block.id) : undefined;
            const argStr = block.input !== undefined
              ? cap(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2))
              : undefined;
            toolCalls.push({
              sessionId,
              spanId: block.id || rid,
              parentSpanId: rid,
              timestamp: tsToMs(gl.timestamp),
              duration: 0,
              toolName: block.name || 'unknown',
              status: res?.isError ? 'error' : 'ok',
              isSubagent: isSidechain,
              args: argStr,
              result: res?.text,
            });
          }
        }
      }
    }
    if (!Number.isFinite(groupTs)) { groupTs = 0; }
    const outputText = textParts.length ? cap(textParts.join('\n')) : undefined;
    const reasoningText = thinkingParts.length ? cap(thinkingParts.join('\n')) : undefined;

    llmRequests.push({
      sessionId,
      provider: 'claude',
      spanId: rid,
      parentSpanId: undefined,
      timestamp: groupTs,
      duration: 0,
      model,
      inputTokens: inclusiveInput,
      outputTokens,
      cachedInputTokens: cacheRead,
      cacheWriteTokens: cacheCreate,
      cacheWrite1hTokens: cacheCreate1h,
      totalTokens: inclusiveInput + outputTokens,
      ttft: 0,
      maxTokens: 0,
      status: 'ok',
      isSubagent: isSidechain,
      subagentName: isSidechain ? subagentName : undefined,
      // All measured from the transcript — 'jsonl' source bypasses cache estimation.
      inputTokensSource: 'jsonl',
      outputTokensSource: 'jsonl',
      cachedInputTokensSource: 'jsonl',
      cacheWriteTokensSource: 'jsonl',
      reasoningTokensSource: 'missing',
      tokenAuditFlags: [],
      directCredits: undefined,
      directCreditsSource: undefined,
      outputText,
      reasoningText,
    });
  }

  llmRequests.sort((a, b) => a.timestamp - b.timestamp);
  toolCalls.sort((a, b) => a.timestamp - b.timestamp);
  userMessages.sort((a, b) => a.timestamp - b.timestamp);

  let session: SessionInfo | null = null;
  if (sawAny || llmRequests.length > 0) {
    session = {
      id: sessionId,
      workspaceId,
      dirPath,
      startTime: Number.isFinite(minTs) ? minTs : 0,
      endTime: maxTs,
      copilotVersion: '',
      vscodeVersion: version || '',
      provider: 'claude',
      cwd,
      branch: gitBranch,
      dataSource: 'jsonl',
    };
  }

  // Turn proxy: Claude has no explicit turn events; one requestId group is the
  // closest analog to a Copilot "turn" (one model invocation cycle).
  const turnCount = llmRequests.length;

  return { session, llmRequests, userMessages, toolCalls, turnCount };
}

/** Convenience: parse a single Claude transcript file (main, no subagents). */
export function parseClaudeFile(
  filePath: string,
  sessionId: string,
  workspaceId: string,
  dirPath: string,
  models: Map<string, ModelInfo>,
  isSubagentFile: boolean,
  subagentName: string | undefined,
): ClaudeCollected {
  return collectClaudeEvents(readJsonlLines(filePath), sessionId, workspaceId, dirPath, models, isSubagentFile, subagentName);
}

export type { ParsedSession };
