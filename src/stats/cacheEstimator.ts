import { LLMRequestRecord, TokenDataSource } from '../core/types';
import { resolveModel } from './billingCalculator';

// =============================================================================
// Hybrid cache estimator
//
// When Copilot Chat debug logs actually report cachedInputTokens / cacheWriteTokens
// we use those values directly. When they don't (the common case today), we
// estimate them using the same rules the providers use:
//
// Provider mechanics (from official docs, fetched May 2026):
//
//   Anthropic (Claude):
//     – Automatic prefix caching, 5-min TTL (refreshed on hit)
//     – cache_read at 0.1× base input price; cache_write at 1.25× base
//     – Min cacheable tokens: 1024 (Sonnet 4/4.5, Opus 4/4.1),
//       2048 (Sonnet 4.6, Haiku 3.5), 4096 (Opus 4.5-4.7, Haiku 4.5)
//     – In multi-turn: previous turns' content is cache_read, new delta is cache_write
//     – 20-block lookback window
//
//   OpenAI (GPT):
//     – Automatic prefix caching, minimum 1024 tokens
//     – TTL: 5-10 min idle (in-memory), up to 24h (extended, gpt-4.1+)
//     – Cached tokens billed at 50% of input price (cachedInput in MODEL_TABLE)
//     – No separate cache-write surcharge
//     – Exact prefix matching
//
//   Google (Gemini):
//     – Implicit caching auto-enabled for 2.5+
//     – Min tokens: 1024 (Flash), 4096 (Pro)
//     – Cost savings passed through automatically
//     – Similar prefix-matching semantics
//
// Estimation algorithm:
//   Within a session, requests to the SAME model are grouped chronologically.
//   For each non-first request in the group:
//     1. If the gap from the previous request exceeds the TTL, no cache hit.
//     2. If input tokens are below the model's min cacheable threshold, no cache hit.
//     3. The estimated cached portion = overlap between consecutive prefixes,
//        approximated as min(prevInputTokens, currInputTokens) because multi-turn
//        conversations grow monotonically — each request re-sends the full prior
//        context plus new content. The new delta = curr - cached.
//     4. Subagent requests get their own cache scope (fresh context) — they don't
//        carry over from the parent's conversation.
//
// The first request in every group is always a cache miss (cache_write for the
// full input). In practice, Copilot runs 2+ LLM calls per turn (tool-use loops),
// making prefix caching extremely common even in short sessions.
// =============================================================================

// ---------- Provider-specific constants ------------------------------------

/** Minimum number of input tokens for caching to apply. */
const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  // Anthropic
  'claude-opus-4.7':      4096,
  'claude-opus-4.6':      4096,
  'claude-opus-4.6-fast': 4096,
  'claude-opus-4.5':      4096,
  'claude-opus-4.1':      1024,
  'claude-opus-4':        1024,
  'claude-sonnet-4.6':    2048,
  'claude-sonnet-4.5':    1024,
  'claude-sonnet-4':      1024,
  'claude-haiku-4.5':     4096,
  'claude-haiku-3.5':     2048,
  // OpenAI — all 1024
  // Google — Flash 1024, Pro 4096
  'gemini-2.5-pro':       4096,
  'gemini-3.1-pro':       4096,
  'gemini-3-flash':       1024,
};

/** Default min cacheable tokens for providers with a uniform threshold. */
const DEFAULT_MIN_CACHEABLE: Record<string, number> = {
  anthropic: 1024,
  openai:    1024,
  google:    1024,
  xai:       1024,
  github:    1024,
};

/** Cache TTL in milliseconds (gap after which a cache miss is assumed). */
const CACHE_TTL_MS: Record<string, number> = {
  anthropic: 5 * 60_000,        // 5 min
  openai:    10 * 60_000,       // 5-10 min; we use the generous end
  google:    5 * 60_000,        // implicit caching, no published TTL; assume 5 min
  xai:       5 * 60_000,
  github:    5 * 60_000,
};

const DEFAULT_TTL_MS = 5 * 60_000;

// ---------- Helpers --------------------------------------------------------

function getProvider(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude') || id.startsWith('haiku') || id.startsWith('sonnet') || id.startsWith('opus')) { return 'anthropic'; }
  if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) { return 'openai'; }
  if (id.startsWith('gemini')) { return 'google'; }
  if (id.startsWith('grok')) { return 'xai'; }
  return 'github';
}

function getMinCacheableTokens(resolvedModelId: string): number {
  if (MIN_CACHEABLE_TOKENS[resolvedModelId] !== undefined) {
    return MIN_CACHEABLE_TOKENS[resolvedModelId];
  }
  const provider = getProvider(resolvedModelId);
  return DEFAULT_MIN_CACHEABLE[provider] ?? 1024;
}

function getCacheTtlMs(resolvedModelId: string): number {
  const provider = getProvider(resolvedModelId);
  return CACHE_TTL_MS[provider] ?? DEFAULT_TTL_MS;
}

// ---------- Public API -----------------------------------------------------

export interface CacheEstimate {
  cachedInputTokens: number;
  cacheWriteTokens: number;
  isEstimated: boolean;
  cachedInputTokensSource: TokenDataSource;
  cacheWriteTokensSource: TokenDataSource;
  auditFlags: string[];
}

/**
 * For a single request, decide whether to use measured or estimated cache values.
 */
export function estimateSingleRequest(
  req: LLMRequestRecord,
  prevReqSameModel: LLMRequestRecord | undefined,
): CacheEstimate {
  const { entry } = resolveModel(req.model);
  const minTokens = getMinCacheableTokens(entry.id);
  const ttlMs = getCacheTtlMs(entry.id);
  const provider = getProvider(entry.id);

  // If the log already has authoritative cached-token data, use it as-is.
  // This intentionally treats a measured zero as measured, not as missing.
  if (isMeasuredSource(req.cachedInputTokensSource) || isMeasuredSource(req.cacheWriteTokensSource)) {
    return {
      cachedInputTokens: req.cachedInputTokens,
      cacheWriteTokens: req.cacheWriteTokens,
      isEstimated: false,
      cachedInputTokensSource: req.cachedInputTokensSource ?? 'unknown',
      cacheWriteTokensSource: req.cacheWriteTokensSource ?? 'unknown',
      auditFlags: req.tokenAuditFlags ?? [],
    };
  }

  if (req.inputTokens < minTokens) {
    return {
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      isEstimated: true,
      cachedInputTokensSource: 'estimated',
      cacheWriteTokensSource: 'estimated',
      auditFlags: ['cache_estimated_below_min_threshold'],
    };
  }

  // No prior request in this model group ? pure cache miss.
  if (!prevReqSameModel) {
    return estimateCacheMiss(req, provider);
  }

  // TTL expired ? cache miss.
  const gap = req.timestamp - prevReqSameModel.timestamp;
  if (gap > ttlMs) {
    return estimateCacheMiss(req, provider, ['cache_estimated_ttl_expired']);
  }

  // Compaction detection: if inputTokens dropped significantly from the previous
  // request, the conversation was summarized/compacted. After compaction the
  // context is completely rewritten, so the prefix hash changes ? cache miss.
  const prevInput = prevReqSameModel.inputTokens;
  if (prevInput > 0 && req.inputTokens < prevInput * 0.7) {
    return estimateCacheMiss(req, provider, ['cache_estimated_context_compaction']);
  }

  // Estimate prefix overlap: in multi-turn, the previous request's input is
  // a prefix of the current request. The overlap is bounded by both.
  const cachedTokens = Math.min(prevInput, req.inputTokens);
  const cacheWriteTokens = provider === 'anthropic'
    ? Math.max(0, req.inputTokens - cachedTokens)
    : 0;

  return {
    cachedInputTokens: cachedTokens,
    cacheWriteTokens,
    isEstimated: true,
    cachedInputTokensSource: 'estimated',
    cacheWriteTokensSource: provider === 'anthropic' ? 'estimated' : 'missing',
    auditFlags: ['cache_estimated_prefix_overlap'],
  };
}

function estimateCacheMiss(req: LLMRequestRecord, provider: string, auditFlags: string[] = ['cache_estimated_miss']): CacheEstimate {
  const cacheWriteTokens = provider === 'anthropic' ? req.inputTokens : 0;
  return {
    cachedInputTokens: 0,
    cacheWriteTokens,
    isEstimated: true,
    cachedInputTokensSource: 'estimated',
    cacheWriteTokensSource: provider === 'anthropic' ? 'estimated' : 'missing',
    auditFlags,
  };
}

function isMeasuredSource(source: TokenDataSource | undefined): boolean {
  return source === 'otel' || source === 'prompt_export' || source === 'jsonl';
}

/**
 * Annotate an array of LLMRequestRecords with cache estimates.
 *
 * Requests are grouped by sessionId so that cache scopes never bleed across
 * sessions (provider caches are per-connection / per-conversation, not global).
 * Within each session, requests are further scoped by resolvedModel × subagent.
 *
 * Returns a new array of records with cachedInputTokens / cacheWriteTokens populated.
 * Records that already have measured values are returned unchanged.
 */
export function estimateSessionCaching(requests: LLMRequestRecord[]): {
  requests: (LLMRequestRecord & { cacheIsEstimated: boolean })[];
  anyEstimated: boolean;
  anyMeasured: boolean;
} {
  // Sort chronologically.
  const sorted = [...requests].sort((a, b) => a.timestamp - b.timestamp);

  // Per-session scope tracking. Cache state resets at session boundaries.
  // Key: sessionId ? scope ? last request seen.
  const sessionScopes = new Map<string, Map<string, LLMRequestRecord>>();
  const results: (LLMRequestRecord & { cacheIsEstimated: boolean })[] = [];
  let anyEstimated = false;
  let anyMeasured = false;

  for (const req of sorted) {
    const { entry } = resolveModel(req.model);
    const sessionKey = req.sessionId;
    const scope = entry.id + '|' + (req.isSubagent ? (req.subagentName || '__subagent__') : '__main__');

    if (!sessionScopes.has(sessionKey)) {
      sessionScopes.set(sessionKey, new Map());
    }
    const scopeMap = sessionScopes.get(sessionKey)!;
    const prev = scopeMap.get(scope);

    const est = estimateSingleRequest(req, prev);

    if (!est.isEstimated) {
      anyMeasured = true;
      results.push({ ...req, cacheIsEstimated: false });
    } else {
      anyEstimated = true;
      results.push({
        ...req,
        cachedInputTokens: est.cachedInputTokens,
        cacheWriteTokens: est.cacheWriteTokens,
        cachedInputTokensSource: est.cachedInputTokensSource,
        cacheWriteTokensSource: est.cacheWriteTokensSource,
        tokenAuditFlags: [...(req.tokenAuditFlags ?? []), ...est.auditFlags],
        cacheIsEstimated: true,
      });
    }

    // Update the "last seen" for this scope within this session.
    scopeMap.set(scope, req);
  }

  return { requests: results, anyEstimated, anyMeasured };
}
