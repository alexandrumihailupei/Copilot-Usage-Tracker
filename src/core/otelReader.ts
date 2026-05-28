// ---------------------------------------------------------------------------
// OTel Agent Traces DB Reader
//
// Primary data source (Tier 1). Exports and reads the SQLite database that
// the Copilot extension maintains internally with OpenTelemetry spans.
// Contains cached_tokens, reasoning_tokens, trace hierarchy, turn indexes,
// and session metadata (repository, branch) — richer than the JSONL logs.
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { OtelSpan, OtelSession, OtelSessionData } from './otelTypes';
import {
  ParsedSession,
  SessionInfo,
  LLMRequestRecord,
  UserMessageRecord,
  ToolCallRecord,
  ModelInfo,
} from './types';

const EXPORT_COMMAND = 'github.copilot.chat.otel.exportAgentTracesDB';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Check if the OTel export command is available in this VS Code session. */
export async function isOtelExportAvailable(): Promise<boolean> {
  const commands = await vscode.commands.getCommands(true);
  return commands.includes(EXPORT_COMMAND);
}

/**
 * Export the OTel Agent Traces DB to a temp file and read all sessions from it.
 * Returns grouped session data, or an empty array if export is unavailable.
 *
 * The caller is responsible for passing a valid wasmPath for sql.js.
 */
export async function exportAndReadOtelDB(
  wasmPath: string
): Promise<OtelSessionData[]> {
  const available = await isOtelExportAvailable();
  if (!available) { return []; }

  const tmpDir = os.tmpdir();
  const exportDir = path.join(tmpDir, `copilot-otel-export-${Date.now()}`);
  fs.mkdirSync(exportDir, { recursive: true });

  try {
    // The command copies the internal DB to the specified path.
    await vscode.commands.executeCommand(EXPORT_COMMAND, vscode.Uri.file(exportDir));

    const dbPath = path.join(exportDir, 'agent-traces.db');
    if (!fs.existsSync(dbPath)) { return []; }

    return await readOtelDB(dbPath, wasmPath);
  } catch (err) {
    console.warn('[CopilotTracker] OTel DB export failed:', err);
    return [];
  } finally {
    // Clean up temp directory
    try { fs.rmSync(exportDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Read all sessions and their spans from an exported OTel SQLite DB file.
 */
async function readOtelDB(dbPath: string, wasmPath: string): Promise<OtelSessionData[]> {
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  try {
    // Verify the expected tables exist
    const tables = queryRows(db, "SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = new Set(tables.map(r => r.name as string));
    if (!tableNames.has('spans') || !tableNames.has('sessions')) {
      console.warn('[CopilotTracker] OTel DB missing expected tables');
      return [];
    }

    // Read sessions
    const sessions = queryRows(db,
      'SELECT id, cwd, repository, host_type, branch, summary, agent_name, agent_description, created_at FROM sessions'
    ).map(mapOtelSession);

    // Read all spans
    const spans = queryRows(db,
      `SELECT span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
              status_code, status_message, operation_name, provider_name, agent_name,
              conversation_id, request_model, response_model,
              input_tokens, output_tokens, cached_tokens, reasoning_tokens,
              tool_name, tool_call_id, tool_type,
              chat_session_id, turn_index, ttft_ms
       FROM spans ORDER BY start_time_ms`
    ).map(mapOtelSpan);

    // Read span attributes (for extra metadata)
    const attrs = queryRows(db,
      'SELECT span_id, key, value FROM span_attributes'
    );
    const attrMap = new Map<string, Map<string, string>>();
    for (const a of attrs) {
      const spanId = a.span_id as string;
      if (!attrMap.has(spanId)) { attrMap.set(spanId, new Map()); }
      attrMap.get(spanId)!.set(a.key as string, (a.value as string) ?? '');
    }

    // Group spans by chat_session_id, falling back to conversation_id
    const spansBySession = new Map<string, OtelSpan[]>();
    for (const span of spans) {
      const sessionId = span.chat_session_id ?? span.conversation_id ?? '__orphan';
      if (!spansBySession.has(sessionId)) { spansBySession.set(sessionId, []); }
      spansBySession.get(sessionId)!.push(span);
    }

    // Build session index
    const sessionById = new Map<string, OtelSession>();
    for (const s of sessions) { sessionById.set(s.id, s); }

    // Assemble grouped data
    const result: OtelSessionData[] = [];
    for (const [sessionId, sessionSpans] of spansBySession) {
      if (sessionId === '__orphan' || sessionSpans.length === 0) { continue; }

      const session = sessionById.get(sessionId) ?? {
        id: sessionId, cwd: null, repository: null, host_type: null,
        branch: null, summary: null, agent_name: null, agent_description: null,
        created_at: null,
      };

      // Collect attributes only for this session's spans
      const sessionAttrs = new Map<string, Map<string, string>>();
      for (const span of sessionSpans) {
        const spanAttrs = attrMap.get(span.span_id);
        if (spanAttrs) { sessionAttrs.set(span.span_id, spanAttrs); }
      }

      result.push({ session, spans: sessionSpans, attributes: sessionAttrs });
    }

    return result;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Mapping OTel ? domain types
// ---------------------------------------------------------------------------

/**
 * Convert an OTel session's data into a ParsedSession compatible with the
 * existing pipeline (database.ts, tokenStats.ts, billingCalculator.ts).
 */
export function mapOtelToParsedSession(data: OtelSessionData): ParsedSession | undefined {
  const { session, spans } = data;

  // LLM request spans: have request_model set
  const llmSpans = spans.filter(s => s.request_model !== null && s.input_tokens !== null);
  if (llmSpans.length === 0) { return undefined; }

  const startTime = spans.reduce((min, s) => Math.min(min, s.start_time_ms), Infinity);
  const endTime = spans.reduce((max, s) => Math.max(max, s.end_time_ms), 0);

  // Determine the "main" agent name for subagent detection
  const mainAgentName = session.agent_name ?? detectMainAgent(llmSpans);

  const sessionInfo: SessionInfo = {
    id: session.id,
    workspaceId: '',
    dirPath: session.cwd ?? '',
    startTime,
    endTime,
    copilotVersion: '',
    vscodeVersion: '',
    repository: session.repository ?? undefined,
    branch: session.branch ?? undefined,
    cwd: session.cwd ?? undefined,
    agentName: session.agent_name ?? undefined,
    agentDescription: session.agent_description ?? undefined,
    dataSource: 'otel',
  };

  // Map LLM spans ? LLMRequestRecord
  const llmRequests: LLMRequestRecord[] = llmSpans.map(span => {
    const isSubagent = span.agent_name !== null && span.agent_name !== mainAgentName;
    const inputTokens = span.input_tokens ?? 0;
    const cachedTokens = span.cached_tokens ?? 0;

    // Check span_attributes for an explicit cache_write_tokens value
    const spanAttrs = data.attributes.get(span.span_id);
    const explicitCacheWrite = spanAttrs ? safeAttrInt(spanAttrs.get('cache_write_tokens') ?? spanAttrs.get('cache_creation_input_tokens')) : undefined;

    // Derive cacheWriteTokens: for Anthropic models, uncached input tokens are written
    // to cache on each request. For other providers, there is no cache-write surcharge.
    const isAnthropic = isAnthropicModel(span.request_model ?? '');
    let cacheWriteTokens: number;
    let cacheWriteSource: 'otel' | 'estimated' | 'missing';
    if (explicitCacheWrite !== undefined) {
      cacheWriteTokens = explicitCacheWrite;
      cacheWriteSource = 'otel';
    } else if (isAnthropic && span.cached_tokens !== null && inputTokens > 0) {
      // Derive: new tokens not served from cache are written to cache
      cacheWriteTokens = Math.max(0, inputTokens - cachedTokens);
      cacheWriteSource = 'estimated';
    } else {
      cacheWriteTokens = 0;
      cacheWriteSource = isAnthropic ? 'missing' : 'missing';
    }

    const auditFlags: string[] = [];
    if (span.cached_tokens === null) { auditFlags.push('cached_tokens_missing_otel'); }
    if (isAnthropic && explicitCacheWrite === undefined && span.cached_tokens !== null) {
      auditFlags.push('cache_write_derived_from_otel');
    }

    return {
      sessionId: session.id,
      spanId: span.span_id,
      parentSpanId: span.parent_span_id ?? undefined,
      timestamp: span.start_time_ms,
      duration: span.end_time_ms - span.start_time_ms,
      model: span.request_model!,
      inputTokens,
      outputTokens: span.output_tokens ?? 0,
      cachedInputTokens: cachedTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + (span.output_tokens ?? 0),
      ttft: span.ttft_ms ?? 0,
      maxTokens: 0,
      status: span.status_code === 2 ? 'error' : 'ok',
      error: span.status_message ?? undefined,
      isSubagent,
      subagentName: isSubagent ? span.agent_name ?? undefined : undefined,
      userRequestPreview: undefined,
      reasoningTokens: span.reasoning_tokens ?? 0,
      responseModel: span.response_model ?? undefined,
      traceId: span.trace_id,
      conversationId: span.conversation_id ?? undefined,
      inputTokensSource: span.input_tokens !== null ? 'otel' : 'missing',
      outputTokensSource: span.output_tokens !== null ? 'otel' : 'missing',
      cachedInputTokensSource: span.cached_tokens !== null ? 'otel' : 'missing',
      cacheWriteTokensSource: cacheWriteSource,
      reasoningTokensSource: span.reasoning_tokens !== null ? 'otel' : 'missing',
      tokenAuditFlags: auditFlags,
    };
  });

  // Tool call spans: have tool_name set
  const toolSpans = spans.filter(s => s.tool_name !== null);
  const toolCalls: ToolCallRecord[] = toolSpans.map(span => ({
    sessionId: session.id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id ?? undefined,
    timestamp: span.start_time_ms,
    duration: span.end_time_ms - span.start_time_ms,
    toolName: span.tool_name!,
    status: span.status_code === 2 ? 'error' : 'ok',
    isSubagent: span.agent_name !== null && span.agent_name !== mainAgentName,
    toolType: span.tool_type ?? undefined,
    toolCallId: span.tool_call_id ?? undefined,
  }));

  // User messages: we don't have full text from OTel, create stubs from LLM request attributes
  const userMessages: UserMessageRecord[] = [];
  // Deduce user messages from turn boundaries: each unique turn_index with the first LLM request
  const seenTurns = new Set<number>();
  for (const span of llmSpans) {
    if (span.turn_index !== null && !seenTurns.has(span.turn_index)) {
      seenTurns.add(span.turn_index);
      const attrs = data.attributes.get(span.span_id);
      const preview = attrs?.get('user.message') ?? attrs?.get('user_request') ?? '';
      userMessages.push({
        sessionId: session.id,
        spanId: `um-turn-${span.turn_index}`,
        timestamp: span.start_time_ms,
        contentLength: preview.length,
        contentPreview: preview.substring(0, 200),
      });
    }
  }

  // Count unique turns
  const maxTurn = llmSpans.reduce((max, s) => Math.max(max, s.turn_index ?? 0), 0);
  const turnCount = seenTurns.size > 0 ? seenTurns.size : maxTurn + 1;

  // Collect unique subagent names
  const subagentNames = [...new Set(
    llmSpans
      .filter(s => s.agent_name !== null && s.agent_name !== mainAgentName)
      .map(s => s.agent_name!)
  )];

  // Build model map from seen models
  const models = new Map<string, ModelInfo>();
  for (const r of llmRequests) {
    if (!models.has(r.model)) {
      models.set(r.model, {
        id: r.model,
        name: r.model,
        vendor: '',
        billingMultiplier: 1,
        isPremium: true,
        maxContextTokens: 0,
        maxOutputTokens: 0,
      });
    }
  }

  return {
    session: sessionInfo,
    llmRequests,
    userMessages,
    toolCalls,
    turnCount,
    subagentNames,
    childSessionFiles: [],
    models,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Detect the main agent by finding the most common agent_name among LLM spans. */
function detectMainAgent(spans: OtelSpan[]): string {
  const counts = new Map<string, number>();
  for (const s of spans) {
    if (s.agent_name) {
      counts.set(s.agent_name, (counts.get(s.agent_name) ?? 0) + 1);
    }
  }
  let maxName = '';
  let maxCount = 0;
  for (const [name, count] of counts) {
    if (count > maxCount) { maxName = name; maxCount = count; }
  }
  return maxName;
}

type SqlRow = Record<string, unknown>;

function queryRows(db: SqlJsDatabase, sql: string, params?: unknown[]): SqlRow[] {
  const result = db.exec(sql, params as any[]);
  if (result.length === 0) { return []; }
  const cols = result[0].columns;
  return result[0].values.map((row: unknown[]) => {
    const obj: SqlRow = {};
    cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
    return obj;
  });
}

function mapOtelSession(row: SqlRow): OtelSession {
  return {
    id: row.id as string,
    cwd: row.cwd as string | null,
    repository: row.repository as string | null,
    host_type: row.host_type as string | null,
    branch: row.branch as string | null,
    summary: row.summary as string | null,
    agent_name: row.agent_name as string | null,
    agent_description: row.agent_description as string | null,
    created_at: row.created_at as string | null,
  };
}

function mapOtelSpan(row: SqlRow): OtelSpan {
  return {
    span_id: row.span_id as string,
    trace_id: row.trace_id as string,
    parent_span_id: row.parent_span_id as string | null,
    name: row.name as string,
    start_time_ms: row.start_time_ms as number,
    end_time_ms: row.end_time_ms as number,
    status_code: (row.status_code as number) ?? 0,
    status_message: row.status_message as string | null,
    operation_name: row.operation_name as string | null,
    provider_name: row.provider_name as string | null,
    agent_name: row.agent_name as string | null,
    conversation_id: row.conversation_id as string | null,
    request_model: row.request_model as string | null,
    response_model: row.response_model as string | null,
    input_tokens: row.input_tokens as number | null,
    output_tokens: row.output_tokens as number | null,
    cached_tokens: row.cached_tokens as number | null,
    reasoning_tokens: row.reasoning_tokens as number | null,
    tool_name: row.tool_name as string | null,
    tool_call_id: row.tool_call_id as string | null,
    tool_type: row.tool_type as string | null,
    chat_session_id: row.chat_session_id as string | null,
    turn_index: row.turn_index as number | null,
    ttft_ms: row.ttft_ms as number | null,
  };
}

function isAnthropicModel(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes('claude') || id.includes('haiku') || id.includes('sonnet') || id.includes('opus');
}

function safeAttrInt(v: string | undefined): number | undefined {
  if (v === undefined) { return undefined; }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
