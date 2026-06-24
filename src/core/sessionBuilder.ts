import {
  TypedLogEvent,
  SessionStartEvent,
  LLMRequestEvent,
  UserMessageEvent,
  ToolCallEvent,
  SubagentEvent,
  TurnEvent,
  ParsedSession,
  SessionInfo,
  LLMRequestRecord,
  UserMessageRecord,
  ToolCallRecord,
  ModelInfo,
  DiscoveredSession,
} from './types';
import { parseJsonlFile, parseJsonlFileSync } from './logParser';
import { parseModelsJson, getBillingMultiplier } from './modelResolver';

const PREVIEW_LENGTH = 200;

/**
 * Build a fully parsed session from a discovered session on disk.
 */
export async function buildSession(
  discovered: DiscoveredSession,
  parseSubagents: boolean
): Promise<ParsedSession | null> {
  const mainResult = await parseJsonlFile(discovered.mainJsonlPath);
  if (mainResult.events.length === 0) { return null; }

  // Parse models.json if available
  const models: Map<string, ModelInfo> = discovered.modelsJsonPath
    ? parseModelsJson(discovered.modelsJsonPath)
    : new Map();

  // Collect events from main file
  const collected = collectEvents(
    mainResult.events,
    discovered.sessionId,
    discovered.workspaceId,
    discovered.dirPath,
    models,
    false,
    undefined
  );

  // Parse subagent child files if enabled
  if (parseSubagents) {
    for (const childPath of discovered.childJsonlPaths) {
      const subagentName = extractSubagentName(childPath);
      // Skip title/categorization/summarize files (low value)
      if (isHousekeepingFile(childPath)) { continue; }

      try {
        const childResult = parseJsonlFileSync(childPath);
        const childCollected = collectEvents(
          childResult.events,
          discovered.sessionId,
          discovered.workspaceId,
          discovered.dirPath,
          models,
          true,
          subagentName
        );
        collected.llmRequests.push(...childCollected.llmRequests);
        collected.userMessages.push(...childCollected.userMessages);
        collected.toolCalls.push(...childCollected.toolCalls);
        collected.turnCount += childCollected.turnCount;
        if (subagentName) {
          collected.subagentNames.add(subagentName);
        }
      } catch {
        // Skip unreadable child files
      }
    }
  }

  if (!collected.session) { return null; }

  return {
    session: collected.session,
    llmRequests: collected.llmRequests,
    userMessages: collected.userMessages,
    toolCalls: collected.toolCalls,
    turnCount: collected.turnCount,
    subagentNames: Array.from(collected.subagentNames),
    childSessionFiles: discovered.childJsonlPaths,
    models,
  };
}

interface CollectedData {
  session: SessionInfo | null;
  llmRequests: LLMRequestRecord[];
  userMessages: UserMessageRecord[];
  toolCalls: ToolCallRecord[];
  turnCount: number;
  subagentNames: Set<string>;
}

function collectEvents(
  events: TypedLogEvent[],
  sessionId: string,
  workspaceId: string,
  dirPath: string,
  models: Map<string, ModelInfo>,
  isSubagent: boolean,
  subagentName: string | undefined
): CollectedData {
  let session: SessionInfo | null = null;
  const llmRequests: LLMRequestRecord[] = [];
  const userMessages: UserMessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let turnCount = 0;
  const subagentNames = new Set<string>();
  let lastTs = 0;

  for (const event of events) {
    if (event.ts > lastTs) { lastTs = event.ts; }

    switch (event.type) {
      case 'session_start': {
        const e = event as SessionStartEvent;
        if (!session) {
          session = {
            id: sessionId,
            workspaceId,
            dirPath,
            startTime: e.ts,
            endTime: e.ts,
            copilotVersion: e.attrs.copilotVersion || '',
            vscodeVersion: e.attrs.vscodeVersion || '',
          };
        }
        break;
      }

      case 'llm_request': {
        const e = event as LLMRequestEvent;
        const attrs = e.attrs as Record<string, unknown>;
        const inputTokens = e.attrs.inputTokens ?? 0;
        const outputTokens = e.attrs.outputTokens ?? 0;
        // Copilot Chat writes cached prompt tokens as `cachedTokens`; the OTel
        // path and older builds use `cachedInputTokens`. Accept either.
        const cachedInputTokens = (attrs.cachedInputTokens as number | undefined)
          ?? (attrs.cachedTokens as number | undefined) ?? 0;
        const cacheWriteTokens = e.attrs.cacheWriteTokens ?? 0;
        const hasCachedInputTokens = Object.prototype.hasOwnProperty.call(attrs, 'cachedInputTokens')
          || Object.prototype.hasOwnProperty.call(attrs, 'cachedTokens');
        const hasCacheWriteTokens = Object.prototype.hasOwnProperty.call(attrs, 'cacheWriteTokens');

        // Check for direct credit cost reported by the API (post-June 2026 billing).
        // copilotUsageNanoAiu is the authoritative field: 1,000,000,000 nanoAIU = 1 credit = $0.01.
        let directCredits: number | undefined;
        if (typeof e.attrs.copilotUsageNanoAiu === 'number' && e.attrs.copilotUsageNanoAiu >= 0) {
          directCredits = e.attrs.copilotUsageNanoAiu / 1_000_000_000;
        } else {
          // Fallback to generic credit keys (future-proofing for API changes).
          const raw = e.attrs.credits ?? e.attrs.aiCredits ?? e.attrs.requestCredits
            ?? (attrs['gen_ai.usage.credits'] as number | undefined)
            ?? (attrs['billing.credits'] as number | undefined);
          directCredits = typeof raw === 'number' && raw >= 0 ? raw : undefined;
        }

        llmRequests.push({
          sessionId,
          spanId: e.spanId,
          parentSpanId: e.parentSpanId,
          timestamp: e.ts,
          duration: e.dur,
          model: e.attrs.model || 'unknown',
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteTokens,
          totalTokens: inputTokens + outputTokens,
          ttft: e.attrs.ttft ?? 0,
          maxTokens: e.attrs.maxTokens ?? 0,
          status: e.status,
          error: e.attrs.error,
          isSubagent,
          subagentName,
          userRequestPreview: e.attrs.userRequest
            ? e.attrs.userRequest.substring(0, PREVIEW_LENGTH)
            : undefined,
          inputTokensSource: 'jsonl',
          outputTokensSource: 'jsonl',
          cachedInputTokensSource: hasCachedInputTokens ? 'jsonl' : 'missing',
          cacheWriteTokensSource: hasCacheWriteTokens ? 'jsonl' : 'missing',
          reasoningTokensSource: 'missing',
          tokenAuditFlags: hasCachedInputTokens ? [] : ['cached_tokens_missing_jsonl'],
          directCredits,
          directCreditsSource: directCredits !== undefined ? 'jsonl' : undefined,
        });
        break;
      }

      case 'user_message': {
        const e = event as UserMessageEvent;
        const content = e.attrs.content || '';
        userMessages.push({
          sessionId,
          spanId: e.spanId,
          timestamp: e.ts,
          contentLength: content.length,
          contentPreview: content.substring(0, PREVIEW_LENGTH),
        });
        break;
      }

      case 'tool_call': {
        const e = event as ToolCallEvent;
        toolCalls.push({
          sessionId,
          spanId: e.spanId,
          parentSpanId: e.parentSpanId,
          timestamp: e.ts,
          duration: e.dur,
          toolName: e.name,
          status: e.status,
          isSubagent,
        });
        break;
      }

      case 'subagent': {
        const e = event as SubagentEvent;
        if (e.attrs.agentName) {
          subagentNames.add(e.attrs.agentName);
        }
        break;
      }

      case 'turn_start':
        turnCount++;
        break;
    }
  }

  // Update session endTime
  if (session && lastTs > session.endTime) {
    session.endTime = lastTs;
  }

  return { session, llmRequests, userMessages, toolCalls, turnCount, subagentNames };
}

function extractSubagentName(filePath: string): string | undefined {
  const filename = filePath.split(/[\\/]/).pop() || '';
  // runSubagent-<agentName>-<uuid>.jsonl
  const match = filename.match(/^runSubagent-(.+?)-[0-9a-f-]+\.jsonl$/i);
  return match ? match[1] : undefined;
}

function isHousekeepingFile(filePath: string): boolean {
  const filename = filePath.split(/[\\/]/).pop() || '';
  return (
    filename.startsWith('title-') ||
    filename.startsWith('categorization-') ||
    filename.startsWith('summarize-')
  );
}
