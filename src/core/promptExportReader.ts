import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveModel } from '../stats/billingCalculator';

// ---------------------------------------------------------------------------
// Prompt Export Reader
//
// Uses the same data source as the GitHub Copilot Token Tracker extension:
// the hidden VS Code command "github.copilot.chat.debug.exportAllPromptLogsAsJson"
// which exports prompt logs with full usage metadata including
// usage.prompt_tokens_details.cached_tokens.
//
// Our debug JSONL logs do NOT expose cached token counts. This module
// bridges that gap by exporting the prompt data and extracting the real
// cached token counts, which can then be used to enrich our DB records.
// ---------------------------------------------------------------------------

const EXPORT_COMMAND = 'github.copilot.chat.debug.exportAllPromptLogsAsJson';
const NO_PROMPTS_MSG = 'No chat prompts found to export.';

/** Parsed prompt entry with token usage details. */
export interface PromptUsageEntry {
  /** Request key — requestId ?? serverRequestId ?? ourRequestId ?? synthesised */
  key: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  /** Tokens written to cache (Anthropic cache_creation_input_tokens). 0 if not available. */
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number | undefined;
  timeToFirstTokenMs: number | undefined;
  timestamp: string | undefined;
  timestampMs: number | undefined;
}

export interface PromptUsageMatch {
  entry: PromptUsageEntry;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  confidence: number;
  timestampDeltaMs: number | undefined;
  auditFlags: string[];
}

// ---------- Command availability check ------------------------------------

/** Check if the Copilot export command is available. */
export async function isPromptExportAvailable(): Promise<boolean> {
  const commands = await vscode.commands.getCommands(true);
  return commands.includes(EXPORT_COMMAND);
}

// ---------- Export & parse -------------------------------------------------

/**
 * Export all Copilot prompt logs to a temp file and parse them.
 * Returns the parsed entries, or an empty array on failure / unavailability.
 *
 * Temporarily suppresses the "No chat prompts found to export" notification
 * to avoid confusing the user during automated sync.
 */
export async function exportAndParsePromptLogs(): Promise<PromptUsageEntry[]> {
  const available = await isPromptExportAvailable();
  if (!available) { return []; }

  const tmpDir = os.tmpdir();
  const exportPath = path.join(tmpDir, `copilot-prompt-export-${Date.now()}.json`);

  try {
    // Call the Copilot export command (same as the other extension does).
    await vscode.commands.executeCommand(EXPORT_COMMAND, exportPath);

    // Read & parse the exported file.
    if (!fs.existsSync(exportPath)) { return []; }
    const raw = fs.readFileSync(exportPath, 'utf-8');
    const data = JSON.parse(raw);
    return parsePromptExport(data);
  } catch (err: unknown) {
    // The command throws when there are no prompts — suppress silently.
    if (isNoPromptsError(err)) { return []; }
    console.warn('[CopilotTracker] Prompt export failed:', err);
    return [];
  } finally {
    // Clean up the temp file.
    try { fs.unlinkSync(exportPath); } catch { /* ignore */ }
  }
}

// ---------- Internal parsing -----------------------------------------------

const VALID_REQUEST_TYPES = new Set(['ChatCompletions', 'ChatMessages', 'ChatResponses']);

function parsePromptExport(data: unknown): PromptUsageEntry[] {
  if (!isObj(data) || !Array.isArray((data as Record<string, unknown>).prompts)) { return []; }

  const entries: PromptUsageEntry[] = [];
  const prompts = (data as Record<string, unknown>).prompts as unknown[];

  for (let pi = 0; pi < prompts.length; pi++) {
    const prompt = prompts[pi];
    if (!isObj(prompt)) { continue; }
    const logs = (prompt as Record<string, unknown>).logs as unknown[];
    if (!Array.isArray(logs)) { continue; }

    for (let li = 0; li < logs.length; li++) {
      const entry = parseLogEntry(logs[li], pi, li);
      if (entry) { entries.push(entry); }
    }
  }

  return entries;
}

function parseLogEntry(log: unknown, promptIdx: number, logIdx: number): PromptUsageEntry | undefined {
  if (!isObj(log)) { return; }
  const rec = log as Record<string, unknown>;

  const kind = str(rec.kind);
  const type = str(rec.type);
  if (kind !== 'request' || type !== 'ChatMLSuccess') { return; }

  const meta = isObj(rec.metadata) ? rec.metadata as Record<string, unknown> : {};
  const usage = isObj(meta.usage) ? meta.usage as Record<string, unknown> : {};

  const promptTokens = safeInt(usage.prompt_tokens);
  const completionTokens = safeInt(usage.completion_tokens);
  const totalTokens = Math.max(safeInt(usage.total_tokens), promptTokens + completionTokens);

  const promptDetails = isObj(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  const cachedPromptTokens = safeInt(promptDetails.cached_tokens);
  // Anthropic exposes cache_creation_input_tokens for tokens written to cache
  const cacheCreationTokens = safeInt(promptDetails.cache_creation_input_tokens)
    || safeInt(usage.cache_creation_input_tokens);

  const completionDetails = isObj(usage.completion_tokens_details)
    ? usage.completion_tokens_details as Record<string, unknown>
    : {};
  const reasoningTokens = Math.max(safeInt(usage.reasoning_tokens), safeInt(completionDetails.reasoning_tokens));

  const model = str(meta.model) ?? 'unknown';
  const requestType = str(meta.requestType);
  if (!requestType || !VALID_REQUEST_TYPES.has(requestType)) { return; }

  const requestId = str(meta.requestId);
  const serverRequestId = str(meta.serverRequestId);
  const ourRequestId = str(meta.ourRequestId);
  const name = str(rec.name);
  const id = str(rec.id);

  const key = requestId ?? serverRequestId ?? ourRequestId
    ?? id
    ?? `fallback-${promptIdx}:${logIdx}:${model}:${promptTokens}:${completionTokens}`;

  const timestamp = str(meta.endTime) ?? str(meta.startTime);
  const timestampMs = parseTimestampMs(timestamp);

  // For Anthropic models, derive cache_write if not explicitly provided:
  // cache_write = prompt_tokens - cached_tokens (new tokens that weren't in cache)
  const isAnthropic = model.toLowerCase().includes('claude')
    || model.toLowerCase().includes('haiku')
    || model.toLowerCase().includes('sonnet')
    || model.toLowerCase().includes('opus');
  const cacheWriteTokens = cacheCreationTokens > 0
    ? cacheCreationTokens
    : (isAnthropic && cachedPromptTokens > 0)
      ? Math.max(0, promptTokens - cachedPromptTokens)
      : 0;

  return {
    key,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    cacheWriteTokens,
    reasoningTokens,
    durationMs: safeOptInt(meta.duration),
    timeToFirstTokenMs: safeOptInt(meta.timeToFirstToken),
    timestamp,
    timestampMs,
  };
}

// ---------- Matching -------------------------------------------------------

/**
 * Build a lookup index for matching prompt export entries to our DB records.
 * The prompt export uses different identifiers than our JSONL-based records,
 * so we match on (model, inputTokens, outputTokens) within a narrow timestamp
 * window.
 */
export function buildMatchIndex(entries: PromptUsageEntry[]): PromptMatchIndex {
  return new PromptMatchIndex(entries);
}

export class PromptMatchIndex {
  /**
   * Index by "model|promptTokens|completionTokens" for fast lookup.
   * Multiple entries may share the same key; disambiguate by timestamp proximity.
   */
  private readonly byTokenKey = new Map<string, PromptUsageEntry[]>();
  private readonly consumed = new Set<string>();

  constructor(entries: PromptUsageEntry[]) {
    for (const e of entries) {
      const key = tokenKey(resolveModelForMatch(e.model), e.promptTokens, e.completionTokens);
      const arr = this.byTokenKey.get(key);
      if (arr) { arr.push(e); } else { this.byTokenKey.set(key, [e]); }
    }
  }

  /**
   * Find the best matching prompt export entry for a DB record.
   * Returns match metadata, or undefined if no safe match is found.
   */
  findCachedTokens(model: string, inputTokens: number, outputTokens: number, timestampMs: number): number | undefined {
    return this.findMatch(model, inputTokens, outputTokens, timestampMs)?.cachedPromptTokens;
  }

  findMatch(model: string, inputTokens: number, outputTokens: number, timestampMs: number): PromptUsageMatch | undefined {
    // Resolve through billingCalculator so date-suffixed names match canonical entries.
    const normModel = resolveModelForMatch(model);
    const key = tokenKey(normModel, inputTokens, outputTokens);
    const candidates = this.byTokenKey.get(key);
    if (!candidates || candidates.length === 0) { return undefined; }

    const available = candidates.filter(c => !this.consumed.has(c.key));
    if (available.length === 0) { return undefined; }

    const scored = available
      .map(entry => ({ entry, delta: computeTimestampDelta(entry.timestampMs, timestampMs) }))
      .sort((a, b) => (a.delta ?? Number.MAX_SAFE_INTEGER) - (b.delta ?? Number.MAX_SAFE_INTEGER));

    const best = scored[0];
    const second = scored[1];
    const auditFlags: string[] = [];
    let confidence = 0.75;

    if (best.delta !== undefined) {
      if (best.delta <= 60_000) { confidence = 1; }
      else if (best.delta <= 5 * 60_000) { confidence = 0.9; }
      else {
        auditFlags.push('prompt_export_match_timestamp_far');
        confidence = 0.6;
      }
    } else if (available.length > 1) {
      auditFlags.push('prompt_export_match_ambiguous_no_timestamp');
      return undefined;
    }

    if (second && best.delta !== undefined && second.delta !== undefined && Math.abs(second.delta - best.delta) < 1000) {
      auditFlags.push('prompt_export_match_ambiguous_timestamp');
      return undefined;
    }

    if (available.length > 1) { auditFlags.push('prompt_export_duplicate_token_tuple'); }
    this.consumed.add(best.entry.key);
    return {
      entry: best.entry,
      cachedPromptTokens: best.entry.cachedPromptTokens,
      cacheWriteTokens: best.entry.cacheWriteTokens,
      reasoningTokens: best.entry.reasoningTokens,
      confidence,
      timestampDeltaMs: best.delta,
      auditFlags,
    };
  }

  /** Number of entries in the index. */
  get size(): number {
    let n = 0;
    for (const arr of this.byTokenKey.values()) { n += arr.length; }
    return n;
  }
}

function tokenKey(model: string, prompt: number, completion: number): string {
  return `${model}|${prompt}|${completion}`;
}

/**
 * Resolve model name through billingCalculator for consistent matching.
 * e.g. both 'gpt-4o-mini-2024-07-18' and 'gpt-4o-mini' resolve to 'gpt-4o-mini'.
 */
function resolveModelForMatch(model: string): string {
  const { entry, resolved } = resolveModel(model);
  return resolved ? entry.id : model.trim().toLowerCase();
}

// ---------- Utility --------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') { return; }
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function safeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function safeOptInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (Number.isFinite(n)) { return Math.max(0, Math.floor(n)); }
  return undefined;
}

function parseTimestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) { return undefined; }
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

function computeTimestampDelta(entryTimestampMs: number | undefined, requestTimestampMs: number): number | undefined {
  if (entryTimestampMs === undefined || !Number.isFinite(requestTimestampMs)) { return undefined; }
  return Math.abs(entryTimestampMs - requestTimestampMs);
}

function isNoPromptsError(err: unknown): boolean {
  if (err instanceof Error) { return err.message.includes(NO_PROMPTS_MSG); }
  if (typeof err === 'string') { return err.includes(NO_PROMPTS_MSG); }
  return false;
}
