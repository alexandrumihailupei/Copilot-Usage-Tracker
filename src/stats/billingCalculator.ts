import { CopilotPlan } from '../config';
import { TrackerDatabase } from '../db/database';
import { estimateSessionCaching } from './cacheEstimator';

// =============================================================================
// SOURCES (verified May 2026)
//   Premium requests / multipliers:
//     https://docs.github.com/en/copilot/concepts/billing/copilot-requests
//   Per-token pricing (effective June 1, 2026):
//     https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
//   AI credit allowances (individuals):
//     https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
//   AI credit allowances + promotional period (org/enterprise):
//     https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
//
// Billing change date: June 1, 2026 (request-based -> usage-based / AI Credits)
// Promotional period for Business / Enterprise: Jun 1 - Sep 1, 2026
// =============================================================================

const BILLING_CHANGE_MS = Date.UTC(2026, 5, 1);     // 2026-06-01 00:00 UTC
const PROMO_END_MS      = Date.UTC(2026, 8, 1);     // 2026-09-01 00:00 UTC

export const PRICING_TABLE_VERSION = 20260601;
export const COST_FORMULA_VERSION = 2;

// ---- Premium-request quotas (request-based, current model) ----------------
const PLAN_PREMIUM_REQUESTS: Record<CopilotPlan, number> = {
  free: 50,
  pro: 300,
  'pro+': 1500,
  business: 300,
  enterprise: 1000,
};

// ---- AI-credit allowances (per-license; pooled at billing entity for B/E) -
const PLAN_AI_CREDITS_STANDARD: Record<CopilotPlan, number | null> = {
  free: null,        // not officially published; surface as "estimate"
  pro: 1500,
  'pro+': 7000,
  business: 1900,
  enterprise: 3900,
};

const PLAN_AI_CREDITS_PROMO: Partial<Record<CopilotPlan, number>> = {
  business: 3000,
  enterprise: 7000,
};

// =============================================================================
// MODEL TABLE
// One canonical entry per documented model. `aliases` are matched
// case-insensitively against the model id from the log; longest match wins.
// =============================================================================

interface ModelEntry {
  id: string;                    // canonical id
  multiplier: number;            // request-based multiplier (paid plans)
  freeMultiplier?: number;       // multiplier on Copilot Free (only if different)
  input: number;                 // $ per 1M input tokens (uncached)
  cachedInput: number;           // $ per 1M cached input tokens
  cacheWrite?: number;           // $ per 1M cache-write tokens, when priced separately
  output: number;                // $ per 1M output tokens
  aliases: string[];
}

// Pricing source: docs/copilot/reference/copilot-billing/models-and-pricing
// Multiplier source: docs/copilot/concepts/billing/copilot-requests
const MODEL_TABLE: ModelEntry[] = [
  // ---- Anthropic ----
  { id: 'claude-haiku-4.5',  multiplier: 0.33, freeMultiplier: 1, input: 1.00, cachedInput: 0.10, cacheWrite: 1.25, output: 5.00,  aliases: ['claude-haiku-4.5', 'haiku-4.5'] },
  { id: 'claude-sonnet-4',   multiplier: 1,    input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00, aliases: ['claude-sonnet-4', 'sonnet-4'] },
  { id: 'claude-sonnet-4.5', multiplier: 1,    input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00, aliases: ['claude-sonnet-4.5', 'sonnet-4.5'] },
  { id: 'claude-sonnet-4.6', multiplier: 1,    input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00, aliases: ['claude-sonnet-4.6', 'sonnet-4.6'] },
  { id: 'claude-opus-4.5',   multiplier: 3,    input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00, aliases: ['claude-opus-4.5', 'opus-4.5'] },
  { id: 'claude-opus-4.6',   multiplier: 3,    input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00, aliases: ['claude-opus-4.6', 'opus-4.6'] },
  { id: 'claude-opus-4.6-fast', multiplier: 30, input: 30.00, cachedInput: 3.00, cacheWrite: 37.50, output: 150.00, aliases: ['claude-opus-4.6-fast', 'opus-4.6-fast'] },
  { id: 'claude-opus-4.7',   multiplier: 15,   input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00, aliases: ['claude-opus-4.7', 'opus-4.7'] },

  // ---- OpenAI ----
  // GPT-4.1 / GPT-4o / GPT-5 mini are "included" models: 0 on paid plans, 1 on Free.
  { id: 'gpt-4.1',       multiplier: 0,    freeMultiplier: 1, input: 2.00, cachedInput: 0.50,  output: 8.00,  aliases: ['gpt-4.1'] },
  { id: 'gpt-4o',        multiplier: 0,    freeMultiplier: 1, input: 2.50, cachedInput: 1.25,  output: 10.00, aliases: ['gpt-4o'] },
  { id: 'gpt-4o-mini',   multiplier: 0,    freeMultiplier: 1, input: 0.15, cachedInput: 0.075, output: 0.60,  aliases: ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'] },
  { id: 'gpt-5-mini',    multiplier: 0,    freeMultiplier: 1, input: 0.25, cachedInput: 0.025, output: 2.00,  aliases: ['gpt-5-mini'] },
  { id: 'gpt-5.2',       multiplier: 1,    input: 1.75, cachedInput: 0.175, output: 14.00, aliases: ['gpt-5.2'] },
  { id: 'gpt-5.2-codex', multiplier: 1,    input: 1.75, cachedInput: 0.175, output: 14.00, aliases: ['gpt-5.2-codex'] },
  { id: 'gpt-5.3-codex', multiplier: 1,    input: 1.75, cachedInput: 0.175, output: 14.00, aliases: ['gpt-5.3-codex'] },
  // GPT-5.4: pricing applies to <=272K-token prompts; long-context surcharge not modeled.
  { id: 'gpt-5.4',       multiplier: 1,    input: 2.50, cachedInput: 0.25,  output: 15.00, aliases: ['gpt-5.4'] },
  { id: 'gpt-5.4-mini',  multiplier: 0.33, input: 0.75, cachedInput: 0.075, output: 4.50,  aliases: ['gpt-5.4-mini'] },
  { id: 'gpt-5.4-nano',  multiplier: 0.25, input: 0.20, cachedInput: 0.02,  output: 1.25,  aliases: ['gpt-5.4-nano'] },
  { id: 'gpt-5.5',       multiplier: 7.5,  input: 5.00, cachedInput: 0.50,  output: 30.00, aliases: ['gpt-5.5'] },

  // ---- Google ----
  // Gemini 2.5 Pro / 3.1 Pro: pricing applies to <=200K-token prompts; long-context surcharge not modeled.
  { id: 'gemini-2.5-pro', multiplier: 1,    input: 1.25, cachedInput: 0.125, output: 10.00, aliases: ['gemini-2.5-pro'] },
  { id: 'gemini-3-flash', multiplier: 0.33, input: 0.50, cachedInput: 0.05,  output: 3.00,  aliases: ['gemini-3-flash'] },
  { id: 'gemini-3.1-pro', multiplier: 1,    input: 2.00, cachedInput: 0.20,  output: 12.00, aliases: ['gemini-3.1-pro'] },

  // ---- xAI ----
  { id: 'grok-code-fast-1', multiplier: 0.25, freeMultiplier: 1, input: 0.20, cachedInput: 0.02,  output: 1.50, aliases: ['grok-code-fast-1', 'grok-code-fast'] },

  // ---- Fine-tuned (GitHub) ----
  { id: 'raptor-mini', multiplier: 0,    freeMultiplier: 1, input: 0.25, cachedInput: 0.025, output: 2.00,  aliases: ['raptor-mini'] },
  // Goldeneye: multiplier "Not applicable" on requests, Free=1; pricing per docs uses GPT-5.1-Codex which mirrors GPT-5.x-Codex.
  { id: 'goldeneye',   multiplier: 1,    freeMultiplier: 1, input: 1.25, cachedInput: 0.125, output: 10.00, aliases: ['goldeneye'] },
];

// Pre-build alias index sorted longest-first to avoid prefix collisions
// (e.g. "gpt-5.4-mini" must match before "gpt-5.4").
const ALIAS_INDEX: { alias: string; entry: ModelEntry }[] = MODEL_TABLE
  .flatMap(e => e.aliases.map(a => ({ alias: a.toLowerCase(), entry: e })))
  .sort((a, b) => b.alias.length - a.alias.length);

const DEFAULT_ENTRY: ModelEntry = {
  id: 'unknown',
  multiplier: 1,
  input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00,
  aliases: [],
};

function normalizeModelName(model: string): string {
  return model
    .toLowerCase()
    .replace(/^(anthropic\/|openai\/|google\/|xai\/|github\/)/, '')
    .replace(/_/g, '-')
    .trim();
}

export function resolveModel(model: string | undefined | null): { entry: ModelEntry; resolved: boolean } {
  if (!model) { return { entry: DEFAULT_ENTRY, resolved: false }; }
  const norm = normalizeModelName(model);
  for (const { alias, entry } of ALIAS_INDEX) {
    if (norm === alias || norm.startsWith(alias + '-') || norm.endsWith('-' + alias) || norm.includes(alias)) {
      // Re-validate: alias must appear as a whole token to avoid e.g. "sonnet-4" matching "sonnet-4.5".
      // We rely on longest-first ordering: if norm contains the longest alias, use it.
      if (norm.includes(alias)) { return { entry, resolved: true }; }
    }
  }
  return { entry: DEFAULT_ENTRY, resolved: false };
}

export interface ModelPricing {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  modelId: string;
  modelResolved: boolean;
  pricingTableVersion: number;
}

export function getPricing(model: string): ModelPricing {
  const { entry, resolved } = resolveModel(model);
  return {
    input: entry.input,
    cachedInput: entry.cachedInput,
    cacheWrite: entry.cacheWrite ?? entry.input,
    output: entry.output,
    modelId: entry.id,
    modelResolved: resolved,
    pricingTableVersion: PRICING_TABLE_VERSION,
  };
}

export function getMultiplier(model: string, plan: CopilotPlan = 'pro'): number {
  const { entry } = resolveModel(model);
  if (plan === 'free' && entry.freeMultiplier !== undefined) { return entry.freeMultiplier; }
  return entry.multiplier;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;   // tokens served from cache (cheaper rate)
  cacheWriteTokens?: number;    // tokens written to cache (Anthropic; usually surcharged)
  reasoningTokens?: number;     // reasoning/thinking tokens (billed at output rate)
  cacheWriteTokensSource?: string;
}

export interface RequestCostBreakdown {
  requestedModel: string;
  resolvedModel: string;
  modelResolved: boolean;
  pricingTableVersion: number;
  costFormulaVersion: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  rates: {
    input: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
  };
  costs: {
    inputUSD: number;
    cachedInputUSD: number;
    cacheWriteUSD: number;
    outputUSD: number;
    totalUSD: number;
  };
  auditFlags: string[];
}

/**
 * Compute the AI-credit cost (in credits; 1 credit = $0.01) for a single request.
 * cachedInputTokens, when provided, are subtracted from the uncached input bucket.
 */
export function computeCreditsForRequest(model: string, usage: TokenUsage): number {
  return computeCostUSD(model, usage) * 100;
}

export function computeCostUSD(model: string, usage: TokenUsage): number {
  return computeCostBreakdown(model, usage).costs.totalUSD;
}

export function computeCostBreakdown(model: string, usage: TokenUsage): RequestCostBreakdown {
  const p = getPricing(model);
  const auditFlags: string[] = [];
  if (usage.inputTokens < 0) { auditFlags.push('input_tokens_negative'); }
  if (usage.outputTokens < 0) { auditFlags.push('output_tokens_negative'); }
  if ((usage.cachedInputTokens ?? 0) < 0) { auditFlags.push('cached_input_tokens_negative'); }
  if ((usage.cacheWriteTokens ?? 0) < 0) { auditFlags.push('cache_write_tokens_negative'); }
  const cachedIn = Math.max(0, usage.cachedInputTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const uncachedIn = Math.max(0, usage.inputTokens - cachedIn - cacheWrite);
  const out = Math.max(0, usage.outputTokens);
  const inputUSD = (uncachedIn / 1_000_000) * p.input;
  const cachedInputUSD = (cachedIn / 1_000_000) * p.cachedInput;
  const cacheWriteUSD = (cacheWrite / 1_000_000) * p.cacheWrite;
  const outputUSD = (out / 1_000_000) * p.output;
  if (!p.modelResolved) { auditFlags.push('model_unresolved_pricing_fallback'); }
  if (cachedIn + cacheWrite > usage.inputTokens) { auditFlags.push('token_buckets_exceed_input'); }
  if (p.cacheWrite > p.input && (usage.cacheWriteTokens === undefined || usage.cacheWriteTokensSource === 'missing' || usage.cacheWriteTokensSource === 'unknown')) {
    auditFlags.push('cache_write_tokens_missing');
  }

  return {
    requestedModel: model || 'unknown',
    resolvedModel: p.modelId,
    modelResolved: p.modelResolved,
    pricingTableVersion: p.pricingTableVersion,
    costFormulaVersion: COST_FORMULA_VERSION,
    inputTokens: Math.max(0, usage.inputTokens),
    cachedInputTokens: cachedIn,
    cacheWriteTokens: cacheWrite,
    uncachedInputTokens: uncachedIn,
    outputTokens: out,
    rates: { input: p.input, cachedInput: p.cachedInput, cacheWrite: p.cacheWrite, output: p.output },
    costs: {
      inputUSD,
      cachedInputUSD,
      cacheWriteUSD,
      outputUSD,
      totalUSD: inputUSD + cachedInputUSD + cacheWriteUSD + outputUSD,
    },
    auditFlags,
  };
}

// =============================================================================
// Billing-status aggregation
// =============================================================================

export interface BillingStatus {
  current: {
    premiumRequestsUsed: number;
    premiumRequestsQuota: number;
    percentUsed: number;
    costBreakdown: { model: string; requests: number; multipliedCost: number }[];
  };
  new: {
    aiCreditsUsed: number;
    aiCreditsQuota: number | null;
    /** Base (non-promo) allowance for the plan. Same as aiCreditsQuota when no promo is active. */
    baseAiCreditsQuota: number | null;
    /** Extra credits granted by the promotional period (aiCreditsQuota - baseAiCreditsQuota). */
    promoCreditsBonus: number;
    quotaIsPromotional: boolean;
    percentUsed: number | null;
    /** Credits used beyond the base quota (drawing from the promo bonus). */
    promoCreditsUsed: number;
    estimatedCostUSD: number;
    costBreakdown: { model: string; inputTokens: number; outputTokens: number; credits: number }[];
    cachedTokensCaptured: boolean;
    cachedTokensEstimated: boolean;
    /** True when at least one request in the period has API-reported direct credits. */
    directCreditsMeasured: boolean;
  };
  billingPeriodStart: number;
  billingPeriodEnd: number;
  daysRemaining: number;
  isHistoricalPeriod: boolean;
  plan: CopilotPlan;
  notes: string[];
}

export function getBillingPeriodBounds(now = Date.now()): { start: number; end: number; daysRemaining: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end   = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const daysRemaining = Math.ceil((end - now) / 86_400_000);
  return { start, end, daysRemaining };
}

function getAiCreditQuota(plan: CopilotPlan, now = Date.now()): { quota: number | null; promotional: boolean } {
  if (now >= BILLING_CHANGE_MS && now < PROMO_END_MS && PLAN_AI_CREDITS_PROMO[plan] !== undefined) {
    return { quota: PLAN_AI_CREDITS_PROMO[plan]!, promotional: true };
  }
  return { quota: PLAN_AI_CREDITS_STANDARD[plan], promotional: false };
}

export function computeBillingStatus(
  db: TrackerDatabase,
  plan: CopilotPlan,
  now = Date.now(),
  periodOverride?: { start: number; end: number }
): BillingStatus {
  let start: number, end: number, daysRemaining: number;
  if (periodOverride) {
    start = periodOverride.start;
    end = periodOverride.end;
    daysRemaining = 0;
  } else {
    const bounds = getBillingPeriodBounds(now);
    start = bounds.start;
    end = bounds.end;
    daysRemaining = bounds.daysRemaining;
  }

  // Per-message premium-request cost using the ACTUAL model that answered each prompt.
  const userPromptModels = db.getUserPromptModelsInPeriod(start, end);
  const currentBreakdown = new Map<string, { requests: number; multipliedCost: number }>();
  let totalPremiumRequests = 0;
  for (const { model } of userPromptModels) {
    const mult = getMultiplier(model, plan);
    totalPremiumRequests += mult;
    const ex = currentBreakdown.get(model) || { requests: 0, multipliedCost: 0 };
    ex.requests += 1;
    ex.multipliedCost += mult;
    currentBreakdown.set(model, ex);
  }

  // Token-based cost across ALL llm requests in period (incl. tool/subagent calls).
  // Hybrid: use measured cache values when present, estimate otherwise.
  // Prefer API-reported direct credits when available.
  const rawRequests = db.getLLMRequestsInPeriod(start, end);
  const { requests, anyEstimated, anyMeasured } = estimateSessionCaching(rawRequests);
  const newBreakdown = new Map<string, { inputTokens: number; outputTokens: number; credits: number }>();
  let totalAiCredits = 0;
  let directCreditsMeasured = false;
  const cachedTokensCaptured = anyMeasured;
  const cachedTokensEstimated = anyEstimated;
  for (const req of requests) {
    let credits: number;
    if (req.directCredits !== undefined) {
      // Use API-reported value directly — most accurate source.
      credits = req.directCredits;
      directCreditsMeasured = true;
    } else {
      credits = computeCreditsForRequest(req.model, req);
    }
    totalAiCredits += credits;
    const ex = newBreakdown.get(req.model) || { inputTokens: 0, outputTokens: 0, credits: 0 };
    ex.inputTokens += req.inputTokens;
    ex.outputTokens += req.outputTokens;
    ex.credits += credits;
    newBreakdown.set(req.model, ex);
  }

  const premiumQuota = PLAN_PREMIUM_REQUESTS[plan];
  // Suppress quotas for historical/all-time periods — they are per-month allowances.
  const { quota: aiQuota, promotional } = periodOverride
    ? { quota: null as null, promotional: false }
    : getAiCreditQuota(plan, now);

  // Base (non-promo) quota is always the standard allowance regardless of promo period.
  const baseAiQuota = PLAN_AI_CREDITS_STANDARD[plan];
  const promoBonus = (aiQuota !== null && baseAiQuota !== null && promotional)
    ? Math.max(0, aiQuota - baseAiQuota)
    : 0;
  // Credits drawn beyond base quota come from the promo bonus.
  const promoCreditsUsed = baseAiQuota !== null
    ? Math.max(0, totalAiCredits - baseAiQuota)
    : 0;

  const notes: string[] = [];
  if (now < BILLING_CHANGE_MS) {
    notes.push(`Token-based billing takes effect ${new Date(BILLING_CHANGE_MS).toUTCString().slice(0, 16)}; figures shown are projections.`);
  }
  if (promotional) { notes.push('Promotional credit allowance active (June 1 - September 1, 2026).'); }
  if (promotional && promoBonus > 0) {
    notes.push(`Promo bonus: ${promoBonus} extra credits/month (base ${baseAiQuota} + ${promoBonus} free promo = ${aiQuota} total).`);
  }
  if (plan === 'business' || plan === 'enterprise') {
    notes.push('Business/Enterprise AI credits are POOLED across all licensed users; the quota shown is per-license-equivalent.');
  }
  if (plan === 'free') { notes.push('Free-plan AI credit allowance is not officially published; quota shown is omitted.'); }
  if (!cachedTokensCaptured && !cachedTokensEstimated) { notes.push('Cached/cache-write token counts are not present in the logs; cost shown is an upper bound.'); }
  if (cachedTokensEstimated && !cachedTokensCaptured) { notes.push('Cached token values are estimated based on provider caching rules (prefix matching, TTL, min thresholds).'); }
  if (cachedTokensCaptured && cachedTokensEstimated) { notes.push('Some cached token values are measured from logs; others are estimated based on provider caching rules.'); }
  if (directCreditsMeasured) { notes.push('Credit costs are sourced directly from the API for some requests (most accurate).'); }

  return {
    current: {
      premiumRequestsUsed: round1(totalPremiumRequests),
      premiumRequestsQuota: premiumQuota,
      percentUsed: premiumQuota > 0 ? round1((totalPremiumRequests / premiumQuota) * 100) : 0,
      costBreakdown: Array.from(currentBreakdown.entries())
        .map(([model, d]) => ({ model, requests: d.requests, multipliedCost: round1(d.multipliedCost) }))
        .sort((a, b) => b.multipliedCost - a.multipliedCost),
    },
    new: {
      aiCreditsUsed: round1(totalAiCredits),
      aiCreditsQuota: aiQuota,
      baseAiCreditsQuota: periodOverride ? null : baseAiQuota,
      promoCreditsBonus: promoBonus,
      quotaIsPromotional: promotional,
      percentUsed: aiQuota && aiQuota > 0 ? round1((totalAiCredits / aiQuota) * 100) : null,
      promoCreditsUsed: round1(promoCreditsUsed),
      estimatedCostUSD: totalAiCredits / 100,
      costBreakdown: Array.from(newBreakdown.entries())
        .map(([model, d]) => ({ model, inputTokens: d.inputTokens, outputTokens: d.outputTokens, credits: round1(d.credits) }))
        .sort((a, b) => b.credits - a.credits),
      cachedTokensCaptured,
      cachedTokensEstimated,
      directCreditsMeasured,
    },
    billingPeriodStart: start,
    billingPeriodEnd: end,
    daysRemaining,
    isHistoricalPeriod: !!periodOverride,
    plan,
    notes,
  };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
