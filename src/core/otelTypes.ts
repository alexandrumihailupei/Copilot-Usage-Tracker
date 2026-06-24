// ---------------------------------------------------------------------------
// OTel-specific types — mirrors the Copilot Agent Traces DB schema
// ---------------------------------------------------------------------------

/** Row from the `spans` table in the OTel Agent Traces DB. */
export interface OtelSpan {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  start_time_ms: number;
  end_time_ms: number;
  status_code: number;       // 0 = unset, 1 = ok, 2 = error
  status_message: string | null;
  operation_name: string | null;
  provider_name: string | null;
  agent_name: string | null;
  conversation_id: string | null;
  request_model: string | null;
  response_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_type: string | null;
  chat_session_id: string | null;
  turn_index: number | null;
  ttft_ms: number | null;
}

/** Row from the `sessions` table in the OTel Agent Traces DB. */
export interface OtelSession {
  id: string;
  cwd: string | null;
  repository: string | null;
  host_type: string | null;
  branch: string | null;
  summary: string | null;
  agent_name: string | null;
  agent_description: string | null;
  created_at: string | null;
}

/** Row from the `span_attributes` table. */
export interface OtelSpanAttribute {
  span_id: string;
  key: string;
  value: string | null;
}

/** Grouped bundle: a session with all its spans and attributes. */
export interface OtelSessionData {
  session: OtelSession;
  spans: OtelSpan[];
  attributes: Map<string, Map<string, string>>; // span_id ? key ? value
}
