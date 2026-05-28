import * as fs from 'fs';
import * as readline from 'readline';
import {
  RawLogEvent,
  TypedLogEvent,
  SessionStartEvent,
  LLMRequestEvent,
  UserMessageEvent,
  ToolCallEvent,
  AgentResponseEvent,
  SubagentEvent,
  TurnEvent,
  ChildSessionRefEvent,
} from './types';

export interface ParseResult {
  events: TypedLogEvent[];
  parseErrors: number;
}

/**
 * Parse a JSONL file into typed events.
 * Uses streaming to handle large files without loading everything at once.
 */
export async function parseJsonlFile(filePath: string): Promise<ParseResult> {
  const events: TypedLogEvent[] = [];
  let parseErrors = 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }

    try {
      const raw: RawLogEvent = JSON.parse(trimmed);
      events.push(classifyEvent(raw));
    } catch {
      parseErrors++;
    }
  }

  return { events, parseErrors };
}

/**
 * Synchronous variant for smaller files (e.g., subagent logs).
 */
export function parseJsonlFileSync(filePath: string): ParseResult {
  const events: TypedLogEvent[] = [];
  let parseErrors = 0;

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }

    try {
      const raw: RawLogEvent = JSON.parse(trimmed);
      events.push(classifyEvent(raw));
    } catch {
      parseErrors++;
    }
  }

  return { events, parseErrors };
}

function classifyEvent(raw: RawLogEvent): TypedLogEvent {
  switch (raw.type) {
    case 'session_start':
      return raw as SessionStartEvent;
    case 'llm_request':
      return raw as LLMRequestEvent;
    case 'user_message':
      return raw as UserMessageEvent;
    case 'tool_call':
      return raw as ToolCallEvent;
    case 'agent_response':
      return raw as AgentResponseEvent;
    case 'subagent':
      return raw as SubagentEvent;
    case 'turn_start':
    case 'turn_end':
      return raw as TurnEvent;
    case 'generic':
      if (raw.name === 'child_session_ref') {
        return raw as ChildSessionRefEvent;
      }
      return raw;
    default:
      return raw;
  }
}
