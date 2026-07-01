import { ModelInfo } from '../types';

/**
 * Static ModelInfo for Claude models. Claude Code transcripts have no models.json,
 * so the adapter seeds the per-session model map from this table. Used by
 * upsertModelBilling and by context-utilization analytics (maxContextTokens).
 *
 * `billingMultiplier` here is informational only — Claude sessions are billed by
 * the shared per-token cost engine (Anthropic list prices live in
 * billingCalculator.MODEL_TABLE), never by a request multiplier. Keep `vendor`
 * = 'anthropic' so cacheEstimator applies Anthropic cache mechanics.
 */
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-8',   name: 'Claude Opus 4.8',   vendor: 'anthropic', billingMultiplier: 1, isPremium: true,  maxContextTokens: 1_000_000, maxOutputTokens: 64_000 },
  { id: 'claude-opus-4-7',   name: 'Claude Opus 4.7',   vendor: 'anthropic', billingMultiplier: 1, isPremium: true,  maxContextTokens: 200_000,   maxOutputTokens: 64_000 },
  { id: 'claude-opus-4-6',   name: 'Claude Opus 4.6',   vendor: 'anthropic', billingMultiplier: 1, isPremium: true,  maxContextTokens: 200_000,   maxOutputTokens: 64_000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', vendor: 'anthropic', billingMultiplier: 1, isPremium: false, maxContextTokens: 1_000_000, maxOutputTokens: 64_000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', vendor: 'anthropic', billingMultiplier: 1, isPremium: false, maxContextTokens: 1_000_000, maxOutputTokens: 64_000 },
  { id: 'claude-haiku-4-5',  name: 'Claude Haiku 4.5',  vendor: 'anthropic', billingMultiplier: 1, isPremium: false, maxContextTokens: 200_000,   maxOutputTokens: 32_000 },
];

const DEFAULT_CLAUDE_MODEL: Omit<ModelInfo, 'id' | 'name'> = {
  vendor: 'anthropic', billingMultiplier: 1, isPremium: true, maxContextTokens: 200_000, maxOutputTokens: 64_000,
};

/** Build a fresh model map seeded with the known Claude models. */
export function buildClaudeModelMap(): Map<string, ModelInfo> {
  const map = new Map<string, ModelInfo>();
  for (const m of CLAUDE_MODELS) { map.set(m.id, m); }
  return map;
}

/**
 * Return a ModelInfo for a model id seen in a transcript, registering an
 * Anthropic-defaulted entry for unknown ids so analytics never see a zero
 * context window.
 */
export function ensureClaudeModel(map: Map<string, ModelInfo>, id: string): ModelInfo {
  const existing = map.get(id);
  if (existing) { return existing; }
  const info: ModelInfo = { id, name: id, ...DEFAULT_CLAUDE_MODEL };
  map.set(id, info);
  return info;
}
